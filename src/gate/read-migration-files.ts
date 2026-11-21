import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { MIGRATION_LAYOUT } from '../constants/migration-layout.constant';
import type { MigrationFile } from '../types/migration-file.type';
import type { MigrationLayout } from '../types/migration-layout.type';
import { migrationDirectory } from './migration-directory';
import { orderedMigrations } from './ordered-migrations';
import { upSection } from './up-section';

/**
 * Миграции каталога — ровно те и в том порядке, что применит инструмент
 * раскладки (`MIGRATION_LAYOUT`, правила — в `orderedMigrations`): drizzle —
 * по `meta/_journal.json`, Flyway — дерево по версии, golang-migrate —
 * `*.up.*` верхнего уровня по номеру, dbmate — секция `-- migrate:up` файлов
 * верхнего уровня по имени. Раскладка не угадывается: есть журнал drizzle —
 * она, иначе без `layout` — исключение, а не сортировка строк (она ставит
 * `V10__` раньше `V2__`). Другая раскладка — готовый список `MigrationFile[]`
 * в порядке применения. Каталога нет — исключение, а не «миграций ноль».
 */
export function readMigrationFiles(dir: string, layout?: MigrationLayout): MigrationFile[] {
  // Каталога нет — ENOENT сразу, а не «раскладка не определена».
  statSync(dir);
  const effective =
    layout ?? (existsSync(join(dir, 'meta', '_journal.json')) ? MIGRATION_LAYOUT.drizzle : undefined);
  if (effective === undefined || !Object.values<string>(MIGRATION_LAYOUT).includes(effective)) {
    throw new Error(
      `readMigrationFiles: раскладка ${dir} не определена — нет meta/_journal.json drizzle; укажите layout (${Object.values(MIGRATION_LAYOUT).join(' | ')}) или передайте список MigrationFile[]`,
    );
  }
  const recursive = effective === MIGRATION_LAYOUT.flyway || effective === MIGRATION_LAYOUT.drizzle;
  return orderedMigrations(dir, effective, migrationDirectory(dir, recursive)).map((name) => {
    const sql = readFileSync(join(dir, name), 'utf8');
    return { name, sql: effective === MIGRATION_LAYOUT.dbmate ? upSection(name, sql) : sql };
  });
}
