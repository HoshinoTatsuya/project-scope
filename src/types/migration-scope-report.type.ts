export interface MigrationScopeReport {
  readonly violations: readonly string[];
  /** Таблицы с колонкой области по миграциям — выборка гейта. */
  readonly scopedTables: readonly string[];
  /** Записи `notScoped`, которые понадобились миграциям. */
  readonly usedNotScoped: readonly string[];
}
