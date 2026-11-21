import { sql } from 'drizzle-orm';
import { type PgPolicy, pgPolicy } from 'drizzle-orm/pg-core';

import { maintenancePredicateSql } from '../scope/maintenance-predicate-sql';
import { scopePredicateSql } from '../scope/scope-predicate-sql';
import type { ProjectScope } from '../types/project-scope.type';

/**
 * Те же политики, что `scopePolicySql`, — объектами drizzle для третьего
 * аргумента `pgTable` (вместе с `.enableRLS()`): drizzle-kit сгенерирует
 * `CREATE POLICY` и `ENABLE ROW LEVEL SECURITY`.
 *
 * FORCE и отзыв TRUNCATE drizzle-kit не генерирует — их добавляют в ту же
 * миграцию руками (`ALTER TABLE … FORCE ROW LEVEL SECURITY`, `REVOKE TRUNCATE
 * ON … FROM PUBLIC, CURRENT_USER`), иначе владелец таблицы политик не проходит
 * и TRUNCATE стирает все области. Пропуск FORCE ловят гейт и `assertScopeReady`,
 * право TRUNCATE — `assertScopeReady`.
 */
export function scopePgPolicies(scope: ProjectScope): PgPolicy[] {
  const predicate = sql.raw(scopePredicateSql(scope));
  const policies = [
    pgPolicy(scope.policyName, {
      as: 'permissive',
      for: 'all',
      to: 'public',
      using: predicate,
      withCheck: predicate,
    }),
  ];
  if (scope.maintenanceRole !== null) {
    policies.push(
      pgPolicy(scope.maintenancePolicyName, {
        as: 'permissive',
        for: 'all',
        to: scope.maintenanceRole,
        using: sql.raw(maintenancePredicateSql(scope)),
        withCheck: sql.raw(maintenancePredicateSql(scope)),
      }),
    );
  }
  return policies;
}
