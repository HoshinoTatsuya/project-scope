import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { MigrationDirectory } from '../types/migration-directory.type';

/**
 * Файлы каталога миграций так, как их видит инструмент: `recursive` — всё
 * дерево (Flyway, drizzle-kit), иначе только верхний уровень (golang-migrate
 * и dbmate подкаталоги не читают — ответы самих инструментов в
 * `src/testing/layout-oracle`), а файлы подкаталогов — отдельно, чтобы
 * похожий на миграцию файл там был отказом, а не тихо пропущенным.
 *
 * Символическая ссылка на каталог — отказ: идёт ли по ней инструмент и нет ли
 * цикла, не определить (сырой ELOOP вместо ответа гейта). Ссылка на файл
 * читается как файл.
 */
export function migrationDirectory(dir: string, recursive: boolean): MigrationDirectory {
  const visible: string[] = [];
  const nested: string[] = [];
  const walk = (current: string, prefix: string, depth: number): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const relative = `${prefix}${name}`;
      const link = lstatSync(path).isSymbolicLink();
      if (statSync(path).isDirectory()) {
        if (link) {
          throw new Error(
            `readMigrationFiles: ${relative} — символическая ссылка на каталог: обходит ли её инструмент и нет ли цикла, не определить`,
          );
        }
        walk(path, `${relative}/`, depth + 1);
      } else {
        (depth === 0 || recursive ? visible : nested).push(relative);
      }
    }
  };
  walk(dir, '', 0);
  return { visible, nested };
}
