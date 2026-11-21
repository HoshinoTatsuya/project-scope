import { MIGRATION_STATEMENT } from '../constants/migration-statement.constant';
import type { ForeignKeyDeclaration } from '../types/foreign-key-declaration.type';
import { sqlObjectName } from './sql-object-name';

/**
 * Внешний ключ в элементе CREATE TABLE или действии ALTER TABLE ADD (без
 * `ADD`): ограничение таблицы `[CONSTRAINT имя] FOREIGN KEY (…) REFERENCES …`
 * или ограничение колонки `колонка тип … REFERENCES …`. Нет ключа — null.
 * Имя ключа без явного — то, что даст сервер: `таблица_колонки_fkey`
 * (без усечения до 63 байт).
 */
export function foreignKeyDeclaration(table: string, element: string): ForeignKeyDeclaration | null {
  const namesOf = (list: string): string[] =>
    list
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .map(sqlObjectName);
  const defaultName = (columns: readonly string[]): string =>
    `${table.slice(table.lastIndexOf('.') + 1)}_${columns.join('_')}_fkey`;
  const tableKey = MIGRATION_STATEMENT.tableForeignKey.exec(element);
  if (tableKey !== null) {
    const columns = namesOf(tableKey[2] ?? '');
    return {
      name: tableKey[1] === undefined ? defaultName(columns) : sqlObjectName(tableKey[1]),
      table,
      columns,
      references: sqlObjectName(tableKey[3] ?? ''),
      referencedColumns: tableKey[4] === undefined ? null : namesOf(tableKey[4]),
    };
  }
  if (MIGRATION_STATEMENT.tableConstraint.test(element)) {
    return null;
  }
  const columnKey = MIGRATION_STATEMENT.columnForeignKey.exec(element);
  const column = MIGRATION_STATEMENT.columnName.exec(
    element.replace(/^COLUMN (?:IF NOT EXISTS )?/i, ''),
  )?.[1];
  if (columnKey === null || column === undefined) {
    return null;
  }
  const columns = [sqlObjectName(column)];
  return {
    name: columnKey[1] === undefined ? defaultName(columns) : sqlObjectName(columnKey[1]),
    table,
    columns,
    references: sqlObjectName(columnKey[2] ?? ''),
    referencedColumns: columnKey[3] === undefined ? null : namesOf(columnKey[3]),
  };
}
