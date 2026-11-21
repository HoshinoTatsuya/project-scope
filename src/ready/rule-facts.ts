import type { PoolClient } from 'pg';

import type { RuleFacts } from '../types/rule-facts.type';

/** Правила (кроме `_RETURN` представлений) на отношениях `oids` или ссылающиеся на них. */
export async function ruleFacts(client: PoolClient, oids: readonly string[]): Promise<RuleFacts[]> {
  const { rows } = await client.query<RuleFacts>(
    `SELECT DISTINCT r.rulename::text AS name, r.ev_class::regclass::text AS relation
       FROM pg_rewrite r
      WHERE r.rulename <> '_RETURN'
        AND (r.ev_class = ANY($1::oid[]) OR EXISTS (
              SELECT 1 FROM pg_depend d
               WHERE d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
                 AND d.refclassid = 'pg_class'::regclass AND d.refobjid = ANY($1::oid[])))
      ORDER BY relation, name`,
    [[...oids]],
  );
  return rows;
}
