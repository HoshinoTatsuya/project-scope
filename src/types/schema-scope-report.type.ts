export interface SchemaScopeReport {
  readonly violations: readonly string[];
  /** Все таблицы drizzle, найденные в схеме, — выборка гейта. */
  readonly tables: readonly string[];
  /** Из них — с колонкой области. */
  readonly scopedTables: readonly string[];
  /** Записи `notScoped`, которые понадобились схеме. */
  readonly usedNotScoped: readonly string[];
}
