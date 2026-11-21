import { maintenancePredicateSql } from '../scope/maintenance-predicate-sql';
import { quoteIdentifier } from '../scope/quote-identifier';
import type { ProjectScope } from '../types/project-scope.type';

/**
 * Политика роли сквозного доступа одной таблицы: все строки — только без
 * контекста области (см. `maintenancePredicateSql`). `quotedRoles` — роль в
 * кавычках (эталон на сервере строится с `PUBLIC`: сравниваются выражения, а
 * роли — отдельно).
 */
export function maintenancePolicySql(scope: ProjectScope, quotedTable: string, quotedRoles: string): string {
  const predicate = maintenancePredicateSql(scope);
  return (
    `CREATE POLICY ${quoteIdentifier(scope.maintenancePolicyName)} ON ${quotedTable} AS PERMISSIVE FOR ALL TO ${quotedRoles} ` +
    `USING (${predicate}) WITH CHECK (${predicate})`
  );
}
