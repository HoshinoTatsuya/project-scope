import type { ScopeCoverageOptions } from '../types/scope-coverage-options.type';
import type { ScopeCoverageReport } from '../types/scope-coverage-report.type';
import { migrationScopeViolations } from './migration-scope-violations';
import { readMigrationFiles } from './read-migration-files';
import { schemaScopeViolations } from './schema-scope-violations';

/** Покрытие области: схема против списка и миграции против схемы защиты (см. оба разбора). */
export function evaluateScopeCoverage(options: ScopeCoverageOptions): ScopeCoverageReport {
  const files =
    typeof options.migrations === 'string'
      ? readMigrationFiles(options.migrations, options.migrationLayout)
      : options.migrations;
  const schema = schemaScopeViolations(options.scope, options.schema, options);
  const migrations = migrationScopeViolations(options.scope, files, options);
  // Допущение «лишнее», только если не понадобилось НИ одному гейту; причина
  // короче порога — одна запись, а не по одной от каждого гейта.
  const usedSomewhere = new Set([...schema.usedNotScoped, ...migrations.usedNotScoped]);
  const needless = (violation: string): boolean =>
    [...usedSomewhere].some((name) => violation === `notScoped.${name}: не понадобилось — уберите запись`);
  return {
    violations: [
      ...new Set(
        [...schema.violations, ...migrations.violations].filter((violation) => !needless(violation)),
      ),
    ],
    schemaTables: schema.tables.length,
    migrations: files.length,
    scopedInSchema: schema.scopedTables,
    scopedInMigrations: migrations.scopedTables,
  };
}
