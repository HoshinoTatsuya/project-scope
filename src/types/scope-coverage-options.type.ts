import type { MigrationFile } from './migration-file.type';
import type { MigrationLayout } from './migration-layout.type';
import type { MigrationScopeOptions } from './migration-scope-options.type';
import type { ProjectScope } from './project-scope.type';
import type { SchemaScopeOptions } from './schema-scope-options.type';

export interface ScopeCoverageOptions extends MigrationScopeOptions, SchemaScopeOptions {
  readonly scope: ProjectScope;
  /** Экспорт модуля drizzle-схемы (`import * as schema`) или их массив. */
  readonly schema: unknown;
  /** Каталог миграций (см. `migrationLayout`) или готовый список по порядку применения. */
  readonly migrations: string | readonly MigrationFile[];
  /**
   * Раскладка каталога `migrations` (`MIGRATION_LAYOUT`). Не задана — drizzle,
   * если есть `meta/_journal.json`, иначе отказ: порядок и состав миграций
   * решает инструмент, а не сортировка имён.
   */
  readonly migrationLayout?: MigrationLayout;
  /** Нижняя граница выборки таблиц схемы (по умолчанию 1): «нарушений ноль» на пустой схеме ничего не значит. */
  readonly minSchemaTables?: number;
  /** Нижняя граница числа миграций (по умолчанию 1). */
  readonly minMigrations?: number;
}
