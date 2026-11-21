import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MIGRATION_LAYOUT } from '../constants/migration-layout.constant';
import type { MigrationDirectory } from '../types/migration-directory.type';
import type { MigrationLayout } from '../types/migration-layout.type';
import { compareVersions } from './compare-versions';
import { versionKey } from './version-key';

/**
 * Пути миграций (относительно `dir`, через `/`) в порядке применения — ровно
 * те, что инструмент раскладки применит вперёд. Правила — по поведению самих
 * инструментов (ответы записаны в `src/testing/layout-oracle/answers.json`,
 * версии там же): drizzle-orm — журнал; Flyway — дерево, `V` с учётом
 * регистра, суффикс `.sql` в любом регистре, версии числами, `R__` последними
 * по описанию; golang-migrate — верхний уровень, `<номер>_<имя>.up.<любое
 * расширение>`; dbmate — верхний уровень, `<цифры>….sql`, по имени файла.
 *
 * Отказ (исключение), а не тихий пропуск:
 * - то, на чём отказывает сам инструмент: повтор версии, журнал drizzle с
 *   `when`, который не растёт (drizzle-orm на существующей базе такую запись
 *   пропускает), файл журнала, которого нет;
 * - файл, похожий на миграцию (`.sql` в любом регистре или имя по шаблону
 *   раскладки), которого инструмент не применит: в подкаталоге у
 *   golang-migrate и dbmate, вне журнала drizzle, с именем не по раскладке
 *   (колбэк Flyway `afterMigrate.sql`, `v2__…`) — гейт и база разошлись бы.
 */
export function orderedMigrations(dir: string, layout: MigrationLayout, files: MigrationDirectory): string[] {
  const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
  const sqlLike = (path: string): boolean => /\.sql$/i.test(path);
  const refuse = (paths: readonly string[], why: string): never => {
    throw new Error(`readMigrationFiles (${layout}): ${paths.join(', ')} — ${why}`);
  };
  /** Файлы, похожие на миграцию, которых инструмент не применит (кроме откатов `skip`). */
  const strays = (
    applied: readonly string[],
    skip: RegExp | null,
    looksLike: RegExp | null,
    why = 'имя не по раскладке: инструмент такой файл не применит',
  ): void => {
    const nested = files.nested.filter((path) => sqlLike(path) || (looksLike?.test(base(path)) ?? false));
    if (nested.length > 0) {
      refuse(nested, 'файл в подкаталоге: инструмент подкаталоги не читает, такой файл не применится');
    }
    const stray = files.visible.filter(
      (path) => sqlLike(path) && !applied.includes(path) && !(skip?.test(base(path)) ?? false),
    );
    if (stray.length > 0) {
      refuse(stray, why);
    }
  };
  /** Повтор версии — отказ инструмента. */
  const unique = <T extends { path: string }>(
    entries: T[],
    keyOf: (entry: T) => string,
    what: string,
  ): T[] => {
    const seen = new Map<string, string>();
    for (const entry of entries) {
      const key = keyOf(entry);
      const first = seen.get(key);
      if (first !== undefined) {
        refuse([first, entry.path], `${what} ${key} встречается дважды — инструмент на этом отказывает`);
      }
      seen.set(key, entry.path);
    }
    return entries;
  };
  switch (layout) {
    case MIGRATION_LAYOUT.drizzle: {
      const journalPath = join(dir, 'meta', '_journal.json');
      if (!existsSync(journalPath)) {
        // drizzle-kit без журнала: каталог на миграцию, порядок — по времени в имени.
        const folders = files.visible.filter((path) => /^[^/]+\/migration\.sql$/.test(path));
        strays(folders, null, null);
        return [...folders].sort();
      }
      const raw = readFileSync(journalPath, 'utf8');
      // BOM в начале: drizzle-orm разбирает журнал JSON.parse без его снятия и
      // отказывает — гейт тоже отказывает, а не читает то, чего инструмент не применит.
      if (raw.startsWith('\ufeff')) {
        return refuse(
          ['meta/_journal.json'],
          'начинается с BOM — drizzle-orm на нём отказывает (сохраните файл без BOM)',
        );
      }
      let journal: { entries?: { tag?: unknown; when?: unknown }[] };
      try {
        journal = JSON.parse(raw) as typeof journal;
      } catch (error) {
        return refuse(
          ['meta/_journal.json'],
          `не JSON (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      if (!Array.isArray(journal.entries)) {
        return refuse(['meta/_journal.json'], 'нет entries');
      }
      let previous: { when: number; path: string } | null = null;
      const ordered = journal.entries.map((entry) => {
        const path = `${String(entry.tag)}.sql`;
        if (typeof entry.tag !== 'string' || !files.visible.includes(path)) {
          return refuse([path], 'есть в журнале, а файла нет');
        }
        // drizzle-orm применяет запись, только если её when БОЛЬШЕ when последней применённой.
        if (typeof entry.when !== 'number' || !Number.isFinite(entry.when)) {
          return refuse(
            [path],
            'в журнале нет числа when — drizzle-orm на существующей базе такую запись пропустит',
          );
        }
        if (previous !== null && entry.when <= previous.when) {
          return refuse(
            [previous.path, path],
            `when ${entry.when} не больше ${previous.when} у предыдущей записи журнала — drizzle-orm на существующей базе пропустит её (применяет только when больше последнего применённого)`,
          );
        }
        previous = { when: entry.when, path };
        return path;
      });
      strays(
        ordered,
        null,
        null,
        'нет в meta/_journal.json — drizzle не применит (внесите в журнал или уберите)',
      );
      return ordered;
    }
    case MIGRATION_LAYOUT.flyway: {
      const suffix = '\\.[sS][qQ][lL]';
      const versioned = unique(
        files.visible.flatMap((path) => {
          const version = new RegExp(`^V(\\d+(?:[._]\\d+)*)__.+${suffix}$`).exec(base(path))?.[1];
          return version === undefined ? [] : [{ path, version }];
        }),
        (entry) => versionKey(entry.version),
        'версия',
      ).sort((a, b) => compareVersions(a.version, b.version));
      // Описание R__ — имя без префикса и суффикса, `_` → пробел; порядок — по нему, как строки Java (UTF-16).
      const repeatable = unique(
        files.visible.flatMap((path) => {
          const description = new RegExp(`^R__(.+)${suffix}$`).exec(base(path))?.[1];
          return description === undefined ? [] : [{ path, description: description.replaceAll('_', ' ') }];
        }),
        (entry) => entry.description,
        'описание повторяемой миграции',
      ).sort((a, b) => (a.description < b.description ? -1 : a.description > b.description ? 1 : 0));
      const applied = [...versioned, ...repeatable].map((entry) => entry.path);
      strays(applied, /^U\d/, null);
      return applied;
    }
    case MIGRATION_LAYOUT.golangMigrate: {
      // Шаблон golang-migrate: ^([0-9]+)_(.*)\.(down|up)\.(.*)$, версия — uint64.
      const pattern = /^([0-9]+)_(.*)\.(down|up)\.(.*)$/;
      const up = files.visible.flatMap((path) => {
        const match = pattern.exec(base(path));
        return match === null || match[3] !== 'up' ? [] : [{ path, version: BigInt(match[1] ?? '') }];
      });
      const huge = up.filter((entry) => entry.version > 0xffff_ffff_ffff_ffffn);
      if (huge.length > 0) {
        refuse(
          huge.map((entry) => entry.path),
          'номер больше uint64: инструмент такой файл не применит',
        );
      }
      const applied = unique(up, (entry) => String(entry.version), 'версия')
        .sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0))
        .map((entry) => entry.path);
      strays(applied, /^[0-9]+_.*\.down\./, pattern);
      return applied;
    }
    case MIGRATION_LAYOUT.dbmate: {
      // dbmate: ^(\d+).*\.sql$ (суффикс — строчными), версия — цифры строкой, порядок — по имени файла.
      const pattern = /^(\d+).*\.sql$/;
      const applied = unique(
        files.visible.flatMap((path) => {
          const version = pattern.exec(base(path))?.[1];
          return version === undefined ? [] : [{ path, version }];
        }),
        (entry) => entry.version,
        'версия',
      )
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((entry) => entry.path);
      strays(applied, null, pattern);
      return applied;
    }
    default:
      return refuse([dir], `раскладка «${String(layout)}» неизвестна`);
  }
}
