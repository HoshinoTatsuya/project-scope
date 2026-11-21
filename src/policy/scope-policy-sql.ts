import { SCOPE_IDENTIFIER } from '../constants/scope-identifier.constant';
import { normalizeTableName } from '../scope/normalize-table-name';
import type { ProjectScope } from '../types/project-scope.type';
import type { ScopePolicySqlOptions } from '../types/scope-policy-sql-options.type';
import { scopeTableStatements } from './scope-table-statements';

/**
 * SQL миграции, включающий изоляцию области на таблицах: для каждой — ENABLE
 * и FORCE ROW LEVEL SECURITY и политика изоляции (см. `scopePredicateSql`:
 * без контекста — ноль строк и отказ записи). Операторы разделены
 * `--> statement-breakpoint` (разделитель drizzle-kit; для сервера это
 * комментарий, текст исполняется и целиком).
 */
export function scopePolicySql(scope: ProjectScope, options: ScopePolicySqlOptions = {}): string {
  const tables = (options.tables ?? scope.tables).map((table) => {
    if (typeof table !== 'string' || !SCOPE_IDENTIFIER.qualifiedName.test(table)) {
      throw new Error(`scopePolicySql: таблица «${String(table)}» — имя или схема.имя в нижнем регистре`);
    }
    return normalizeTableName(table);
  });
  if (tables.length === 0) {
    throw new Error('scopePolicySql: список таблиц пуст');
  }
  return `${tables
    .flatMap((table) => scopeTableStatements(scope, table))
    .join(';\n--> statement-breakpoint\n')};\n`;
}
