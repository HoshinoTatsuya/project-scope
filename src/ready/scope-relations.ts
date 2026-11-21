import type { PoolClient } from 'pg';

import { splitTableName } from '../scope/split-table-name';
import type { ProjectScope } from '../types/project-scope.type';
import type { RelationFacts } from '../types/relation-facts.type';
import { reachableRolesSql } from './reachable-roles-sql';

/**
 * Один проход по каталогу: ВСЕ отношения, которые касаются области, а не
 * только перечисленные в списке:
 * - таблицы списка (любого вида — не-таблица в списке тоже отказ);
 * - их секции и наследники (`pg_inherits`, все уровни): запрос прямо к ним
 *   проходит их собственные политики, а не родителя;
 * - любое отношение с колонкой области (обычная, секционированная, внешняя
 *   таблица, представление, материализованное) в любой схеме, кроме системных
 *   и временных: таблица, созданная мимо списка (`DO $$ … EXECUTE`, вручную),
 *   иначе осталась бы невидимой;
 * - представления и материализованные представления, построенные над всем
 *   этим (рекурсивно, через правило `_RETURN` в `pg_depend`), даже без колонки
 *   области: агрегат по всем областям — тоже вынос данных;
 * - ПРЕДКИ по наследованию таблиц списка и их секций (`pg_inherits` вверх):
 *   запрос к предку читает и меняет строки наследников по политикам ПРЕДКА, а
 *   TRUNCATE предка проверяет права только у него.
 *
 * Права — для КАЖДОЙ роли, чьими правами сессия может воспользоваться
 * (`reachableRolesSql`: наследование или `SET ROLE` от `current_user` и
 * `session_user`; членство без INHERIT даёт права после `SET ROLE`). Право на
 * данные — чтение или запись строк, табличное или на отдельные колонки
 * (`GRANT SELECT (колонка)`); REFERENCES и TRIGGER строк не отдают (оракул
 * существования ключа и триггер — те же, что у владельца таблицы области, см.
 * README). «Недоступно» значит доказанно: ни у одной такой роли нет ни одного
 * права на строки.
 */
export async function scopeRelations(client: PoolClient, scope: ProjectScope): Promise<RelationFacts[]> {
  const parts = scope.tables.map(splitTableName);
  const { rows } = await client.query<RelationFacts>(
    `WITH RECURSIVE
     listed AS (
       SELECT c.oid, l.label
         FROM unnest($2::text[], $3::text[], $4::text[]) AS l(nsp, rel, label)
         JOIN pg_namespace n ON n.nspname = l.nsp
         JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = l.rel
     ),
     tree AS (
       SELECT l.oid, l.label, false AS descendant FROM listed l
       UNION
       SELECT i.inhrelid, t.label, true FROM pg_inherits i JOIN tree t ON i.inhparent = t.oid
     ),
     columned AS (
       SELECT a.attrelid AS oid FROM pg_attribute a WHERE a.attname = $1 AND a.attnum > 0 AND NOT a.attisdropped
     ),
     ancestors AS (
       SELECT i.inhparent AS oid FROM pg_inherits i JOIN tree t ON i.inhrelid = t.oid
       UNION
       SELECT i.inhparent FROM pg_inherits i JOIN ancestors a ON i.inhrelid = a.oid
     ),
     reachable AS (${reachableRolesSql()}),
     base AS (
       SELECT oid FROM tree
       UNION
       SELECT oid FROM columned
       UNION
       SELECT oid FROM ancestors
     ),
     derived AS (
       SELECT oid FROM base
       UNION
       SELECT r.ev_class
         FROM derived x
         JOIN pg_depend d ON d.refclassid = 'pg_class'::regclass AND d.refobjid = x.oid
                         AND d.classid = 'pg_rewrite'::regclass
         JOIN pg_rewrite r ON r.oid = d.objid AND r.rulename = '_RETURN'
     )
     SELECT c.oid::text AS oid, c.oid::regclass::text AS display, c.relkind::text AS kind,
            (SELECT l.label FROM listed l WHERE l.oid = c.oid) AS listed,
            (SELECT min(t.label) FROM tree t WHERE t.oid = c.oid AND t.descendant) AS root,
            c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
            (pg_has_role(current_user, c.relowner, 'MEMBER') OR pg_has_role(session_user, c.relowner, 'MEMBER')) AS owned,
            (c.oid IN (SELECT oid FROM ancestors) AND c.oid NOT IN (SELECT oid FROM tree)) AS ancestor,
            c.relowner IN (SELECT oid FROM pg_roles WHERE rolname IN (current_user, session_user)) AS session_owned,
            (SELECT a.atttypid::regtype::text FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attname = $1 AND a.attnum > 0 AND NOT a.attisdropped) AS column_type,
            (SELECT co.collisdeterministic FROM pg_attribute a JOIN pg_collation co ON co.oid = a.attcollation
              WHERE a.attrelid = c.oid AND a.attname = $1 AND a.attnum > 0 AND NOT a.attisdropped) AS deterministic,
            COALESCE((SELECT o.option_value FROM pg_options_to_table(c.reloptions) o
                       WHERE o.option_name = 'security_invoker'), '') AS invoker,
            EXISTS (SELECT 1 FROM reachable x WHERE has_table_privilege(x.oid, c.oid, 'TRUNCATE')) AS truncate,
            EXISTS (SELECT 1 FROM reachable x
                     WHERE has_table_privilege(x.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
                        OR has_any_column_privilege(x.oid, c.oid, 'SELECT,INSERT,UPDATE')) AS accessible
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid IN (SELECT oid FROM derived)
        AND (c.relkind IN ('r', 'p', 'm', 'v', 'f') OR c.oid IN (SELECT oid FROM listed))
        AND c.relpersistence <> 't'
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_toast%'
      ORDER BY display`,
    [scope.column, parts.map((part) => part.schema), parts.map((part) => part.name), [...scope.tables]],
  );
  return rows;
}
