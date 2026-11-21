import type { PoolClient } from 'pg';
import type { OwnerRightsFacts } from '../types/owner-rights-facts.type';
import type { ProjectScope } from '../types/project-scope.type';
import { reachableRolesSql } from './reachable-roles-sql';

/**
 * Код и доступ, исполняемые НЕ правами сессии, до которых сессия дотягивается:
 * - функции и процедуры вне `pg_catalog` и `information_schema`, которые роль
 *   сессии может исполнить (EXECUTE), которые срабатывают триггером на
 *   отношении, которое она меняет, или событийным триггером (EXECUTE для
 *   триггера проверяется при CREATE TRIGGER, а не при срабатывании):
 *   - SECURITY DEFINER, если владелец обходит политики области —
 *     суперпользователь, BYPASSRLS, член роли с ними, роль сквозного доступа
 *     или член её (без контекста её политика пропускает все строки);
 *   - с параметром области или причины в определении (`SET app.project_id`);
 *   - LEAKPROOF: планировщик вычисляет её условие до политик;
 * - сопоставления пользователей внешних серверов для роли сессии и PUBLIC.
 *
 * Функции расширений с правами владельца (`dblink_connect_u`) EXECUTE у
 * PUBLIC не имеют и сюда не попадают, пока их не выдали.
 */
export async function ownerRightsFacts(client: PoolClient, scope: ProjectScope): Promise<OwnerRightsFacts[]> {
  const { rows } = await client.query<OwnerRightsFacts>(
    `WITH reachable AS (${reachableRolesSql()}),
     modifiable AS (
       SELECT c.oid FROM pg_class c
        WHERE EXISTS (SELECT 1 FROM reachable x
                       WHERE has_table_privilege(x.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE')
                          OR has_any_column_privilege(x.oid, c.oid, 'INSERT,UPDATE'))
     ),
     candidates AS (
       SELECT p.oid FROM pg_proc p
        WHERE p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
     ),
     reached AS (
       SELECT p.oid, 'execute'::text AS how FROM candidates p
        WHERE EXISTS (SELECT 1 FROM reachable x WHERE has_function_privilege(x.oid, p.oid, 'EXECUTE'))
       UNION
       SELECT t.tgfoid, 'trigger' FROM pg_trigger t
        WHERE NOT t.tgisinternal AND t.tgenabled <> 'D' AND t.tgrelid IN (SELECT oid FROM modifiable)
          AND t.tgfoid IN (SELECT oid FROM candidates)
       UNION
       SELECT e.evtfoid, 'event-trigger' FROM pg_event_trigger e
        WHERE e.evtenabled <> 'D' AND e.evtfoid IN (SELECT oid FROM candidates)
     ),
     judged AS (
       SELECT p.oid, p.prosecdef
                AND (o.rolsuper OR o.rolbypassrls
                     OR EXISTS (SELECT 1 FROM pg_roles m
                                 WHERE m.oid <> o.oid AND (m.rolsuper OR m.rolbypassrls)
                                   AND pg_has_role(o.oid, m.oid, 'MEMBER'))
                     OR EXISTS (SELECT 1 FROM pg_roles m
                                 WHERE m.rolname = $1 AND pg_has_role(o.oid, m.oid, 'MEMBER'))) AS definer,
              EXISTS (SELECT 1 FROM unnest(p.proconfig) AS c(item)
                       WHERE lower(split_part(c.item, '=', 1)) IN ($2, $3)) AS sets_scope,
              p.proleakproof AS leakproof
         FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
        WHERE p.oid IN (SELECT oid FROM reached)
     )
     SELECT 'routine' AS kind, j.oid::regprocedure::text AS name, pg_get_userbyid(p.proowner)::text AS owner,
            ARRAY(SELECT DISTINCT r.how FROM reached r WHERE r.oid = j.oid ORDER BY 1) AS paths,
            j.definer, j.sets_scope, j.leakproof
       FROM judged j JOIN pg_proc p ON p.oid = j.oid
      WHERE j.definer OR j.sets_scope OR j.leakproof
     UNION ALL
     SELECT 'mapping', m.srvname::text, CASE WHEN m.umuser = 0 THEN 'PUBLIC' ELSE m.usename::text END,
            ARRAY[]::text[], false, false, false
       FROM pg_user_mappings m
      WHERE m.umuser = 0 OR m.umuser IN (SELECT oid FROM reachable)
      ORDER BY 1, 2, 3`,
    [scope.maintenanceRole, scope.setting, scope.reasonSetting],
  );
  return rows;
}
