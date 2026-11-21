import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readMigrationFiles as readMigrationFilesOfDrizzle } from 'drizzle-orm/migrator';
import { MIGRATION_LAYOUT } from '../constants/migration-layout.constant';
import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { defineProjectScope } from '../scope/define-project-scope';
import type { MigrationFile } from '../types/migration-file.type';
import { migrationScopeViolations } from './migration-scope-violations';
import { readMigrationFiles } from './read-migration-files';

/** Каталог миграций во временной папке: путь → текст. */
const withDirectory = <T>(files: Record<string, string>, read: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), 'project-scope-migrations-'));
  try {
    for (const [path, sql] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), sql);
    }
    return read(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Журнал drizzle-kit: `when` растёт, как пишет drizzle-kit (время создания миграции). */
const journal = (...tags: string[]): string =>
  JSON.stringify({
    version: '7',
    dialect: 'postgresql',
    entries: tags.map((tag, idx) => ({ idx, version: '7', when: 1_794_700_000_000 + idx * 1000, tag })),
  });

const names = (dir: string, layout?: Parameters<typeof readMigrationFiles>[1]): string[] =>
  readMigrationFiles(dir, layout).map((file) => file.name);

describe('readMigrationFiles: состав и порядок — как у инструмента раскладки', () => {
  it('drizzle с журналом: состав и порядок — из журнала; файл вне журнала или отсутствующий — отказ', () => {
    withDirectory(
      {
        'meta/_journal.json': journal('0010_b', '0002_a'),
        '0002_a.sql': 'SELECT 2;',
        '0010_b.sql': 'SELECT 10;',
      },
      (dir) => expect(names(dir)).toEqual(['0010_b.sql', '0002_a.sql']),
    );
    withDirectory(
      { 'meta/_journal.json': journal('0000_a'), '0000_a.sql': 'SELECT 1;', '0001_manual.sql': 'SELECT 2;' },
      (dir) => expect(() => names(dir)).toThrow('0001_manual.sql — нет в meta/_journal.json'),
    );
    withDirectory(
      { 'meta/_journal.json': journal('0000_a', '0001_gone'), '0000_a.sql': 'SELECT 1;' },
      (dir) => expect(() => names(dir)).toThrow('0001_gone.sql — есть в журнале, а файла нет'),
    );
  });

  it('drizzle: when в журнале обязан строго расти и быть числом — drizzle-orm на существующей базе пропускает запись с when не больше последнего', () => {
    const entries = (...whens: unknown[]): string =>
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: whens.map((when, idx) => ({ idx, version: '7', when, tag: `000${idx}_m` })),
      });
    const files = { '0000_m.sql': 'SELECT 0;', '0001_m.sql': 'SELECT 1;', '0002_m.sql': 'SELECT 2;' };
    withDirectory({ ...files, 'meta/_journal.json': entries(1000, 3000, 2000) }, (dir) =>
      expect(() => names(dir)).toThrow(
        '0001_m.sql, 0002_m.sql — when 2000 не больше 3000 у предыдущей записи журнала',
      ),
    );
    withDirectory({ ...files, 'meta/_journal.json': entries(1000, 2000, 2000) }, (dir) =>
      expect(() => names(dir)).toThrow('when 2000 не больше 2000'),
    );
    withDirectory({ ...files, 'meta/_journal.json': entries(1000, '2000', 3000) }, (dir) =>
      expect(() => names(dir)).toThrow('0001_m.sql — в журнале нет числа when'),
    );
    withDirectory({ ...files, 'meta/_journal.json': entries(1000, 2000, 3000) }, (dir) =>
      expect(names(dir)).toEqual(['0000_m.sql', '0001_m.sql', '0002_m.sql']),
    );
  });

  it('журнал drizzle с BOM или не JSON — отказ с причиной (как у drizzle-orm, который на нём тоже отказывает), а не сырой SyntaxError', () => {
    for (const [text, why] of [
      [`\ufeff${journal('0000_a')}`, /BOM.*drizzle-orm на нём отказывает/],
      ['{"entries": [', /meta\/_journal\.json — не JSON/],
    ] as const) {
      withDirectory({ 'meta/_journal.json': text, '0000_a.sql': 'SELECT 1;' }, (dir) => {
        expect(() => names(dir)).toThrow(why);
        // Сам инструмент на том же журнале — отказ: гейт не принимает того, чего не применит drizzle-orm.
        expect(() => readMigrationFilesOfDrizzle({ migrationsFolder: dir })).toThrow(SyntaxError);
      });
    }
    // Двойник: тот же журнал без BOM — читается.
    withDirectory({ 'meta/_journal.json': journal('0000_a'), '0000_a.sql': 'SELECT 1;' }, (dir) => {
      expect(names(dir)).toEqual(['0000_a.sql']);
      expect(readMigrationFilesOfDrizzle({ migrationsFolder: dir })).toHaveLength(1);
    });
  });

  it('раскладка, которой нет (в обход типов), — отказ, а не ветка другого инструмента', () => {
    withDirectory({ '1_init.sql': '-- migrate:up\nSELECT 1;\n' }, (dir) =>
      expect(() => names(dir, 'sqitch' as never)).toThrow(`раскладка ${dir} не определена`),
    );
  });

  it('символическая ссылка на каталог — отказ гейта, а не сырой ELOOP; ссылка на файл читается', () => {
    withDirectory({ 'V1__init.sql': 'SELECT 1;' }, (dir) => {
      symlinkSync(join(dir, 'V1__init.sql'), join(dir, 'V2__again.sql'));
      expect(names(dir, MIGRATION_LAYOUT.flyway)).toEqual(['V1__init.sql', 'V2__again.sql']);
      symlinkSync(dir, join(dir, 'loop'));
      expect(() => names(dir, MIGRATION_LAYOUT.flyway)).toThrow('loop — символическая ссылка на каталог');
    });
  });

  it('drizzle без журнала: каталоги <время>_имя/migration.sql по имени; лишний .sql — отказ', () => {
    withDirectory(
      { '20261116000000_b/migration.sql': 'SELECT 2;', '20261115000000_a/migration.sql': 'SELECT 1;' },
      (dir) =>
        expect(names(dir, MIGRATION_LAYOUT.drizzle)).toEqual([
          '20261115000000_a/migration.sql',
          '20261116000000_b/migration.sql',
        ]),
    );
    withDirectory({ '20261115000000_a/migration.sql': 'SELECT 1;', 'loose.sql': 'SELECT 2;' }, (dir) =>
      expect(() => names(dir, MIGRATION_LAYOUT.drizzle)).toThrow('loose.sql'),
    );
  });

  it('раскладка не задана и журнала нет — отказ, а не сортировка строк', () => {
    withDirectory({ 'V10__b.sql': 'SELECT 10;', 'V2__a.sql': 'SELECT 2;' }, (dir) =>
      expect(() => names(dir)).toThrow('раскладка'),
    );
  });

  it('Flyway: версии — числами (V2 < V10, 1.9 < 1.10), R__ — последними, U (откат) не применяется, чужое имя — отказ', () => {
    const files = {
      'V10__protect.sql': 'SELECT 10;',
      'V1__init.sql': 'SELECT 1;',
      'V2__notes.sql': 'SELECT 2;',
      'sql/V1.10__minor.sql': 'SELECT 1.10;',
      'V1.9__minor.sql': 'SELECT 1.9;',
      'R__views.sql': 'SELECT 0;',
      'U2__undo.sql': 'DROP TABLE notes;',
      'notes.txt': 'не миграция',
    };
    withDirectory(files, (dir) =>
      expect(names(dir, MIGRATION_LAYOUT.flyway)).toEqual([
        'V1__init.sql',
        'V1.9__minor.sql',
        'sql/V1.10__minor.sql',
        'V2__notes.sql',
        'V10__protect.sql',
        'R__views.sql',
      ]),
    );
    withDirectory({ ...files, 'fix.sql': 'SELECT 1;' }, (dir) =>
      expect(() => names(dir, MIGRATION_LAYOUT.flyway)).toThrow('fix.sql — имя не по раскладке'),
    );
  });

  it('golang-migrate: *.up.sql по номеру, *.down.sql не применяется', () => {
    withDirectory(
      {
        '10_noop.up.sql': 'SELECT 10;',
        '10_noop.down.sql': 'ALTER TABLE items NO FORCE ROW LEVEL SECURITY;',
        '2_init.up.sql': 'SELECT 2;',
        '2_init.down.sql': 'DROP TABLE items;',
      },
      (dir) =>
        expect(names(dir, MIGRATION_LAYOUT.golangMigrate)).toEqual(['2_init.up.sql', '10_noop.up.sql']),
    );
  });

  it('dbmate: по имени файла строкой (как dbmate 2.38.1), только секция migrate:up; без маркера или с операторами до него — отказ', () => {
    withDirectory(
      {
        '20261116000000_init.sql':
          '-- migrate:up\nCREATE TABLE items (id int);\n\n-- migrate:down\nDROP TABLE items;\n',
        '9_first.sql': '-- комментарий\n\n-- migrate:up transaction:false\nSELECT 1;\n',
      },
      (dir) =>
        expect(readMigrationFiles(dir, MIGRATION_LAYOUT.dbmate)).toEqual([
          { name: '20261116000000_init.sql', sql: '\nCREATE TABLE items (id int);\n\n' },
          { name: '9_first.sql', sql: '\nSELECT 1;\n' },
        ]),
    );
    withDirectory({ '1_a.sql': 'ALTER TABLE items DISABLE ROW LEVEL SECURITY;\n' }, (dir) =>
      expect(() => names(dir, MIGRATION_LAYOUT.dbmate)).toThrow('1_a.sql — нет строки «-- migrate:up»'),
    );
    withDirectory({ '1_a.sql': 'SELECT 1;\n-- migrate:up\nSELECT 2;\n' }, (dir) =>
      expect(() => names(dir, MIGRATION_LAYOUT.dbmate)).toThrow('1_a.sql — операторы до «-- migrate:up»'),
    );
  });

  it('вывод настоящего drizzle-kit 0.31.10: переход политики сквозного доступа ALTER POLICY и её DROP … CASCADE', () => {
    const fixture = join(__dirname, '..', 'testing', 'drizzle-kit-fixture');
    const files = readMigrationFiles(fixture);
    expect(files.map((file) => file.name)).toEqual([
      '0000_init.sql',
      '0001_maintenance.sql',
      '0002_drop_maintenance.sql',
    ]);
    const scope = defineProjectScope({
      setting: 'app.project_id',
      column: 'project_id',
      columnType: SCOPE_COLUMN_TYPE.uuid,
      tables: ['items'],
      maintenanceRole: 'app_maintenance',
    });
    // drizzle-kit FORCE не пишет: его дописывают в ту же миграцию руками (README).
    const [init, alter, drop] = files.map((file) =>
      file.name === '0000_init.sql'
        ? {
            ...file,
            sql: `${file.sql}\n--> statement-breakpoint\nALTER TABLE "items" FORCE ROW LEVEL SECURITY;`,
          }
        : file,
    ) as [MigrationFile, MigrationFile, MigrationFile];
    // Миграция 0.1.0: политика сквозного доступа USING (true) — нарушение, пока её не изменили.
    expect(migrationScopeViolations(scope, [init]).violations).toEqual([
      '0000_init.sql: политика scope_app_project_id_maintenance на items не та, что строит пакет — роль сквозного доступа видит все строки только без контекста области',
    ]);
    expect(migrationScopeViolations(scope, [init, alter]).violations).toEqual([]);
    // DROP POLICY … CASCADE снимает политику: для области без роли сквозного доступа она чужая, пока есть.
    const withoutRole = defineProjectScope({
      setting: scope.setting,
      column: scope.column,
      columnType: scope.columnType,
      tables: ['items'],
    });
    expect(migrationScopeViolations(withoutRole, [init, alter]).violations).toEqual([
      '0001_maintenance.sql: разрешающая политика scope_app_project_id_maintenance на items — складывается с политикой области через OR и расширяет доступ',
    ]);
    expect(migrationScopeViolations(withoutRole, [init, alter, drop]).violations).toEqual([]);
  });
});
