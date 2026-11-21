/** Внешний ключ из текста миграции: имена — как их хранит Postgres. */
export interface ForeignKeyDeclaration {
  /** Имя ограничения; без явного — то, что даст сервер (`таблица_колонки_fkey`). */
  readonly name: string;
  readonly table: string;
  readonly columns: readonly string[];
  readonly references: string;
  /** Колонки родителя; null — не указаны (ключ на первичный ключ родителя). */
  readonly referencedColumns: readonly string[] | null;
}
