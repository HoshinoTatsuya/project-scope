import type { PoolClient } from 'pg';

import type { SharedCascadeFacts } from '../types/shared-cascade-facts.type';
import { reachableRolesSql } from './reachable-roles-sql';

/**
 * Внешние ключи из отношений `oids` на ОБЩИЕ таблицы (вне `oids`) с каскадом
 * (`CASCADE`, `SET NULL`, `SET DEFAULT`), когда роль, в которую сессия может
 * войти, вправе удалить или изменить строку общей таблицы: из работы области A
 * такое удаление меняет строки всех областей, а каскад идёт мимо RLS.
 */
export async function sharedCascadeFacts(
  client: PoolClient,
  oids: readonly string[],
): Promise<SharedCascadeFacts[]> {
  const { rows } = await client.query<SharedCascadeFacts>(
    `WITH reachable AS (${reachableRolesSql()})
     SELECT con.conname::text AS name, con.conrelid::regclass::text AS child, con.confrelid::regclass::text AS parent,
            ARRAY(SELECT a FROM unnest(ARRAY[
                    CASE WHEN con.confdeltype IN ('c', 'n', 'd') AND EXISTS (
                           SELECT 1 FROM reachable x WHERE has_table_privilege(x.oid, con.confrelid, 'DELETE'))
                         THEN 'ON DELETE' END,
                    CASE WHEN con.confupdtype IN ('c', 'n', 'd') AND EXISTS (
                           SELECT 1 FROM reachable x WHERE has_table_privilege(x.oid, con.confrelid, 'UPDATE')
                              OR has_any_column_privilege(x.oid, con.confrelid, 'UPDATE'))
                         THEN 'ON UPDATE' END]) AS a WHERE a IS NOT NULL) AS actions
       FROM pg_constraint con
      WHERE con.contype = 'f' AND con.conparentid = 0
        AND con.conrelid = ANY($1::oid[]) AND NOT (con.confrelid = ANY($1::oid[]))
      ORDER BY child, name`,
    [[...oids]],
  );
  return rows.filter((row) => row.actions.length > 0);
}
