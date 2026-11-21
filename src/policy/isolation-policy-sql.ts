import { quoteIdentifier } from '../scope/quote-identifier';
import { scopePredicateSql } from '../scope/scope-predicate-sql';
import type { ProjectScope } from '../types/project-scope.type';

/**
 * Политика изоляции одной таблицы. `FOR ALL` и явный WITH CHECK: запись
 * чужого значения области — отказ сервера, а не строка, которую автор больше
 * не увидит. `TO PUBLIC` — на любую роль: роль, которой политика «не досталась»,
 * не видела бы ничего, а не всё, но и работать бы не смогла.
 */
export function isolationPolicySql(scope: ProjectScope, quotedTable: string): string {
  const predicate = scopePredicateSql(scope);
  return (
    `CREATE POLICY ${quoteIdentifier(scope.policyName)} ON ${quotedTable} AS PERMISSIVE FOR ALL TO PUBLIC ` +
    `USING (${predicate}) WITH CHECK (${predicate})`
  );
}
