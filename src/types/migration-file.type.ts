/** Файл миграции: путь (для сообщений) и SQL. Порядок списка — порядок применения. */
export interface MigrationFile {
  readonly name: string;
  readonly sql: string;
}
