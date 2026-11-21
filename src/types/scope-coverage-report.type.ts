export interface ScopeCoverageReport {
  readonly violations: readonly string[];
  readonly schemaTables: number;
  readonly migrations: number;
  /** Таблицы с колонкой области — по схеме и по миграциям. */
  readonly scopedInSchema: readonly string[];
  readonly scopedInMigrations: readonly string[];
}
