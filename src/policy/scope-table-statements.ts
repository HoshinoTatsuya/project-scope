import { quoteIdentifier } from '../scope/quote-identifier';
import type { ProjectScope } from '../types/project-scope.type';
import { isolationPolicySql } from './isolation-policy-sql';
import { maintenancePolicySql } from './maintenance-policy-sql';

/**
 * Операторы защиты одной таблицы: RLS, FORCE (иначе владелец таблицы её не
 * проходит — а роль приложения часто и есть владелец), политика изоляции,
 * политика роли сквозного доступа (если задана) и отзыв TRUNCATE.
 *
 * TRUNCATE политик не проходит: `TRUNCATE` в работе одной области стёр бы все.
 * Право отзывается у PUBLIC и у роли, выполняющей миграцию (обычно владелец
 * таблицы: владелец может отозвать собственное право). Остальные роли с
 * GRANT ALL ловит `assertScopeReady` (`truncate-privilege`).
 */
export function scopeTableStatements(scope: ProjectScope, table: string): string[] {
  const quoted = quoteIdentifier(table);
  const statements = [
    `ALTER TABLE ${quoted} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${quoted} FORCE ROW LEVEL SECURITY`,
    isolationPolicySql(scope, quoted),
  ];
  if (scope.maintenanceRole !== null) {
    statements.push(maintenancePolicySql(scope, quoted, quoteIdentifier(scope.maintenanceRole)));
  }
  statements.push(`REVOKE TRUNCATE ON ${quoted} FROM PUBLIC, CURRENT_USER`);
  return statements;
}
