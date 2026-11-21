/** Файлы каталога миграций (пути относительно каталога, через `/`). */
export interface MigrationDirectory {
  /** Файлы, которые инструмент раскладки видит: верхний уровень или всё дерево. */
  readonly visible: readonly string[];
  /** Файлы подкаталогов, которых инструмент не обходит (golang-migrate, dbmate). */
  readonly nested: readonly string[];
}
