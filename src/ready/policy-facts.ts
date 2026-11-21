import type { PoolClient } from 'pg';

import type { PolicyFacts } from '../types/policy-facts.type';
import { reachableRolesSql } from './reachable-roles-sql';

/** Политики отношений одним запросом; «действует на роль» — на роль, чьими правами сессия может воспользоваться. */
export async function policyFacts(client: PoolClient, oids: readonly string[]): Promise<PolicyFacts[]> {
  const { rows } = await client.query<PolicyFacts>(
    `SELECT p.polrelid::text AS relation, p.polname::text AS name, p.polpermissive AS permissive,
            p.polcmd::text AS command,
            (0::oid = ANY(p.polroles) OR EXISTS (
               SELECT 1 FROM unnest(p.polroles) AS r(oid)
                WHERE r.oid IN (${reachableRolesSql()}))) AS applies,
            ARRAY(SELECT CASE WHEN r.oid = 0 THEN 'public' ELSE pg_get_userbyid(r.oid)::text END
                    FROM unnest(p.polroles) AS r(oid) ORDER BY 1) AS roles,
            pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
       FROM pg_policy p WHERE p.polrelid = ANY($1::oid[]) ORDER BY p.polname`,
    [[...oids]],
  );
  return rows;
}
