import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { MigrationLayout } from '../types/migration-layout.type';
import { readMigrationFiles } from './read-migration-files';

/**
 * Состав и порядок миграций — как у НАСТОЯЩИХ инструментов. Ответы записаны
 * `scripts/layout-oracle.sh`: каждая фикстура `src/testing/layout-oracle/<инструмент>/<случай>`
 * применена самим инструментом (golang-migrate, dbmate, Flyway — версии в
 * ответах) к Postgres, каждый файл пишет свой путь в журнал — так видны и
 * состав, и порядок, и отказ инструмента.
 *
 * Гейт обязан ответить тем же: применённое инструментом — те же пути в том же
 * порядке; отказ инструмента — отказ гейта. Строже инструмента гейт только в
 * одном: файл, похожий на миграцию, который инструмент молча пропускает, —
 * отказ (`STRICTER`, с причиной): гейт и база разошлись бы.
 */
interface ToolAnswer {
  tool: MigrationLayout;
  version: string;
  case: string;
  exitCode: number;
  applied: string[];
  failure: string | null;
}

const ORACLE = join(__dirname, '..', 'testing', 'layout-oracle');
const ANSWERS = JSON.parse(readFileSync(join(ORACLE, 'answers.json'), 'utf8')) as ToolAnswer[];

/**
 * Случаи, где гейт строже инструмента: инструмент молча пропускает файл,
 * похожий на миграцию (или, как колбэк Flyway, исполняет файл вне модели
 * гейта), а гейт отказывает и называет этот файл.
 */
const STRICTER: Readonly<Record<string, string>> = {
  'golang-migrate/subdirectory': 'файл миграции в подкаталоге не применится',
  'golang-migrate/uppercase-direction': '.UP. — не направление для инструмента, файл не применится',
  'golang-migrate/prefix-junk': 'имя не с номера — не применится',
  'golang-migrate/huge-version': 'номер больше uint64 — инструмент файл молча пропускает',
  'dbmate/subdirectory': 'файл миграции в подкаталоге не применится',
  'dbmate/extension': '.SQL в верхнем регистре dbmate не читает',
  'dbmate/prefix-junk': 'имя не с номера — не применится',
  'flyway/lowercase-prefix': 'префикс v строчной Flyway не читает',
  'flyway/prefix-junk': 'имя не с префикса V — не применится',
  'flyway/callback': 'колбэк afterMigrate.sql исполняется после миграций, гейт его не моделирует',
};

/** Все файлы фикстуры (пути через `/`). */
const filesOf = (dir: string, prefix = ''): string[] =>
  readdirSync(dir)
    .sort()
    .flatMap((name) =>
      statSync(join(dir, name)).isDirectory()
        ? filesOf(join(dir, name), `${prefix}${name}/`)
        : [`${prefix}${name}`],
    );

describe('readMigrationFiles против ответов настоящих инструментов', () => {
  it('ответы есть для каждого инструмента и каждой фикстуры, версии инструментов записаны', () => {
    const recorded = new Set(ANSWERS.map((answer) => `${answer.tool}/${answer.case}`));
    const fixtures = ['golang-migrate', 'dbmate', 'flyway'].flatMap((tool) =>
      readdirSync(join(ORACLE, tool)).map((name) => `${tool}/${name}`),
    );
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
    expect([...recorded].sort()).toEqual([...fixtures].sort());
    expect(new Set(ANSWERS.map((answer) => answer.tool))).toEqual(
      new Set(['golang-migrate', 'dbmate', 'flyway']),
    );
    expect(ANSWERS.every((answer) => answer.version.length > 0)).toBe(true);
    // Выборка не выродилась: есть и применённые, и отказы инструмента, и строгие случаи.
    expect(ANSWERS.filter((answer) => answer.exitCode !== 0).length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(STRICTER).every((key) => recorded.has(key))).toBe(true);
  });

  it.each(ANSWERS.map((answer) => [`${answer.tool}/${answer.case}`, answer] as const))(
    '%s',
    (key, answer) => {
      const dir = join(ORACLE, answer.tool, answer.case);
      let gate: string[] | Error;
      try {
        gate = readMigrationFiles(dir, answer.tool).map((file) => file.name);
      } catch (error) {
        gate = error as Error;
      }
      if (answer.exitCode !== 0) {
        // Инструмент отказал — гейт тоже.
        expect(gate).toBeInstanceOf(Error);
      } else if (Object.hasOwn(STRICTER, key)) {
        // Гейт строже: отказ называет файл, который инструмент пропустил (или колбэк, который он исполнил).
        expect(gate).toBeInstanceOf(Error);
        const named = filesOf(dir).filter(
          (path) => !answer.applied.includes(path) || /^(?:before|after)[A-Za-z]*\.sql$/.test(path),
        );
        expect(named.some((path) => (gate as Error).message.includes(path))).toBe(true);
      } else {
        expect(gate).toEqual(answer.applied);
      }
    },
  );
});
