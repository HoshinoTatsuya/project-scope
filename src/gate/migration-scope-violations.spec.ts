import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { scopePolicySql } from '../policy/scope-policy-sql';
import { defineProjectScope } from '../scope/define-project-scope';
import { scopePredicateSql } from '../scope/scope-predicate-sql';
import type { MigrationScopeOptions } from '../types/migration-scope-options.type';
import type { ProjectScope } from '../types/project-scope.type';
import { migrationScopeViolations } from './migration-scope-violations';

const scopeOf = (tables: string[]): ProjectScope =>
  defineProjectScope({
    setting: 'app.project_id',
    column: 'project_id',
    columnType: SCOPE_COLUMN_TYPE.uuid,
    tables,
  });

const SCOPE = scopeOf(['items']);
const PROTECT = scopePolicySql(SCOPE);
const CREATE_ITEMS =
  'CREATE TABLE "items" ("id" serial PRIMARY KEY, "project_id" uuid NOT NULL, "body" text);';
const CREATE_PLAIN = 'CREATE TABLE "plain" ("id" serial PRIMARY KEY, "body" text);';
const REASON = 'таблица создана до перехода на изоляцию областей';

const check = (files: string[], options: MigrationScopeOptions = {}, scope: ProjectScope = SCOPE) =>
  migrationScopeViolations(
    scope,
    files.map((sql, index) => ({ name: `000${index}_m.sql`, sql })),
    options,
  );

/** Как drizzle-kit пишет pgPolicy + enableRLS: без FORCE, `TO public`. */
const drizzleKitStyle = (scope: ProjectScope, table: string): string =>
  `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint\n` +
  `CREATE POLICY "${scope.policyName}" ON "${table}" AS PERMISSIVE FOR ALL TO public USING (${scopePredicateSql(scope)}) WITH CHECK (${scopePredicateSql(scope)});`;

describe('migrationScopeViolations', () => {
  it('таблица области, защищённая той же миграцией, — чисто; выборка не пуста', () => {
    expect(check([`${CREATE_ITEMS}\n${PROTECT}`, CREATE_PLAIN])).toEqual({
      violations: [],
      scopedTables: ['items'],
      usedNotScoped: [],
    });
  });

  it('CREATE TABLE с колонкой области без RLS — нарушение в той миграции, где таблица создана', () => {
    expect(check([CREATE_ITEMS, PROTECT]).violations).toEqual([
      '0000_m.sql: items получает колонку project_id, а миграция не включает ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, политика scope_app_project_id',
    ]);
  });

  it('adoptedLater: защита в поздней миграции допускается с причиной; лишняя и короткая запись — нарушение', () => {
    expect(check([CREATE_ITEMS, PROTECT], { adoptedLater: { items: REASON } }).violations).toEqual([]);
    expect(check([`${CREATE_ITEMS}\n${PROTECT}`], { adoptedLater: { items: REASON } }).violations).toEqual([
      'adoptedLater.items: не понадобилось — уберите запись',
    ]);
    expect(check([CREATE_ITEMS, PROTECT], { adoptedLater: { items: 'legacy' } }).violations).toEqual([
      'допущение items: причина короче 20 символов — объясните, почему',
    ]);
    // Допущение не отменяет требование к концу истории.
    expect(check([CREATE_ITEMS], { adoptedLater: { items: REASON } }).violations).toEqual([
      'items в списке области, а к концу миграций защита не полная',
    ]);
  });

  it('форма drizzle-kit без FORCE — нарушение; закомментированный FORCE не считается', () => {
    expect(check([`${CREATE_ITEMS}\n${drizzleKitStyle(SCOPE, 'items')}`]).violations).toEqual([
      '0000_m.sql: items получает колонку project_id, а миграция не включает FORCE ROW LEVEL SECURITY',
      'items в списке области, а к концу миграций защита не полная',
    ]);
    const commented = `${CREATE_ITEMS}\n${drizzleKitStyle(SCOPE, 'items')}\n-- ALTER TABLE "items" FORCE ROW LEVEL SECURITY;\n/* ALTER TABLE items FORCE ROW LEVEL SECURITY; */`;
    expect(check([commented]).violations).toHaveLength(2);
    const fixed = `${CREATE_ITEMS}\n${drizzleKitStyle(SCOPE, 'items')}\nALTER TABLE "public"."items" FORCE ROW LEVEL SECURITY;`;
    expect(check([fixed]).violations).toEqual([]);
  });

  it.each([
    [
      'DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE items DISABLE ROW LEVEL SECURITY;',
      'ENABLE ROW LEVEL SECURITY',
    ],
    ['NO FORCE', 'ALTER TABLE ONLY "items" NO FORCE ROW LEVEL SECURITY;', 'FORCE ROW LEVEL SECURITY'],
    [
      'DROP POLICY',
      'DROP POLICY IF EXISTS "scope_app_project_id" ON "items";',
      'политика scope_app_project_id',
    ],
  ])('снятие защиты позже (%s) — нарушение', (_label, sql, missing) => {
    expect(check([`${CREATE_ITEMS}\n${PROTECT}`, sql]).violations).toEqual([
      `0001_m.sql: items — защита области снята: нет ${missing}`,
      'items в списке области, а к концу миграций защита не полная',
    ]);
  });

  it('пересоздание политики в одной миграции — чисто', () => {
    const recreate = `DROP POLICY "scope_app_project_id" ON "items";\n${PROTECT.split('--> statement-breakpoint')[2]}`;
    expect(check([`${CREATE_ITEMS}\n${PROTECT}`, recreate]).violations).toEqual([]);
  });

  it.each([
    [
      'пропускает при пустом контексте',
      `USING (current_setting('app.project_id', true) IS NULL OR ${scopePredicateSql(SCOPE)}) WITH CHECK (${scopePredicateSql(SCOPE)})`,
      'выражение не то, что строит пакет (USING и WITH CHECK)',
    ],
    [
      'без WITH CHECK',
      `USING (${scopePredicateSql(SCOPE)})`,
      'выражение не то, что строит пакет (USING и WITH CHECK)',
    ],
    [
      'RESTRICTIVE',
      `AS RESTRICTIVE USING (${scopePredicateSql(SCOPE)}) WITH CHECK (${scopePredicateSql(SCOPE)})`,
      'RESTRICTIVE',
    ],
    [
      'только SELECT',
      `FOR SELECT USING (${scopePredicateSql(SCOPE)}) WITH CHECK (${scopePredicateSql(SCOPE)})`,
      'FOR SELECT',
    ],
    [
      'на одну роль',
      `TO app_user USING (${scopePredicateSql(SCOPE)}) WITH CHECK (${scopePredicateSql(SCOPE)})`,
      'TO app_user',
    ],
  ])('политика области не та (%s) — нарушение', (_label, clause, problem) => {
    const sql = `${CREATE_ITEMS} ALTER TABLE items ENABLE ROW LEVEL SECURITY; ALTER TABLE items FORCE ROW LEVEL SECURITY;
      CREATE POLICY scope_app_project_id ON items ${clause};`;
    expect(check([sql]).violations).toEqual([
      `0000_m.sql: политика scope_app_project_id на items не та: ${problem}`,
      '0000_m.sql: items получает колонку project_id, а миграция не включает политика scope_app_project_id',
      'items в списке области, а к концу миграций защита не полная',
    ]);
  });

  it('ALTER POLICY политики области в чужую форму — нарушение', () => {
    expect(
      check([`${CREATE_ITEMS}\n${PROTECT}`, 'ALTER POLICY scope_app_project_id ON items USING (true);'])
        .violations,
    ).toEqual([
      '0001_m.sql: политика scope_app_project_id на items после ALTER POLICY не та: выражение не то, что строит пакет (USING и WITH CHECK)',
      '0001_m.sql: items — защита области снята: нет политика scope_app_project_id',
      'items в списке области, а к концу миграций защита не полная',
    ]);
  });

  it('ADD COLUMN колонки области к существующей таблице — та миграция обязана включить защиту; таблица — в списке', () => {
    const scope = scopeOf(['items', 'plain']);
    expect(
      check(
        [
          `${CREATE_ITEMS}\n${scopePolicySql(scope, { tables: ['items'] })}`,
          CREATE_PLAIN,
          'ALTER TABLE plain ADD COLUMN project_id uuid;',
        ],
        {},
        scope,
      ).violations,
    ).toEqual([
      '0002_m.sql: plain получает колонку project_id, а миграция не включает ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, политика scope_app_project_id',
      'plain в списке области, а к концу миграций защита не полная',
    ]);
    expect(
      check([`${CREATE_ITEMS}\n${PROTECT}`, CREATE_PLAIN, 'ALTER TABLE plain ADD project_id uuid;'])
        .violations,
    ).toContain('plain: колонка project_id есть, а в списке области таблицы нет');
  });

  it('таблица с колонкой области вне списка и таблица списка, которой нет в миграциях, — нарушения', () => {
    const extra = 'CREATE TABLE IF NOT EXISTS audit.events (id int, "project_id" uuid);';
    expect(check([`${CREATE_ITEMS}\n${PROTECT}`, extra]).violations).toEqual([
      '0001_m.sql: audit.events получает колонку project_id, а миграция не включает ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, политика scope_app_project_id',
      'audit.events: колонка project_id есть, а в списке области таблицы нет',
    ]);
    expect(check([CREATE_PLAIN]).violations).toEqual(['items в списке области, а миграции её не создают']);
    expect(check([`${CREATE_ITEMS}\n${PROTECT}`, 'DROP TABLE plain, items;']).violations).toEqual([
      'items в списке области, а миграции её не создают',
    ]);
  });

  it('колонка области в кавычках, рядом с ограничениями, в другом регистре — распознаётся', () => {
    const sql =
      'create table Items (CONSTRAINT pk PRIMARY KEY (id), id int, "body" text, PROJECT_ID uuid, CHECK (id > 0));';
    expect(check([sql]).violations[0]).toBe(
      '0000_m.sql: items получает колонку project_id, а миграция не включает ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, политика scope_app_project_id',
    );
    // "Project_Id" в кавычках — другая колонка (регистр сохраняется).
    expect(check(['CREATE TABLE items (id int, "Project_Id" uuid);']).violations).toEqual([
      'items в списке области, а колонки project_id в ней нет',
    ]);
  });

  it('CREATE TABLE AS / LIKE не разобран: вне списка без notScoped — нарушение; notScoped и список — нет', () => {
    const copy = 'CREATE TABLE report AS SELECT * FROM items;';
    expect(check([`${CREATE_ITEMS}\n${PROTECT}`, copy]).violations).toEqual([
      '0001_m.sql: CREATE TABLE report не разобран (AS, LIKE, OF) — есть ли колонка project_id, не определить; внесите таблицу в список области или в notScoped с причиной',
    ]);
    expect(
      check([`${CREATE_ITEMS}\n${PROTECT}`, copy], {
        notScoped: { report: 'агрегат без строк проектов внутри' },
      }).violations,
    ).toEqual([]);
    const like = scopeOf(['items', 'items_copy']);
    expect(
      check(
        [
          `${CREATE_ITEMS}\n${scopePolicySql(like, { tables: ['items'] })}`,
          `CREATE TABLE items_copy (LIKE items INCLUDING ALL);\n${scopePolicySql(like, { tables: ['items_copy'] })}`,
        ],
        {},
        like,
      ).violations,
    ).toEqual([]);
    expect(
      check([`${CREATE_ITEMS}\n${PROTECT}`], { notScoped: { report: 'агрегат без строк проектов внутри' } })
        .violations,
    ).toEqual(['notScoped.report: не понадобилось — уберите запись']);
  });

  it('секция и наследник таблицы области обязаны быть защищены, но в список не вносятся', () => {
    const partitioned = `CREATE TABLE items (id int, project_id uuid NOT NULL) PARTITION BY HASH (project_id);\n${PROTECT}`;
    expect(
      check([
        partitioned,
        'CREATE TABLE items_p0 PARTITION OF items FOR VALUES WITH (MODULUS 2, REMAINDER 0);',
      ]).violations,
    ).toEqual([
      '0001_m.sql: items_p0 получает колонку project_id, а миграция не включает ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, политика scope_app_project_id',
    ]);
    expect(
      check([
        partitioned,
        `CREATE TABLE items_p0 PARTITION OF items FOR VALUES WITH (MODULUS 2, REMAINDER 0);\n${scopePolicySql(SCOPE, { tables: ['items_p0'] })}`,
      ]).violations,
    ).toEqual([]);
    expect(
      check([
        partitioned,
        'CREATE TABLE loose (id int, project_id uuid NOT NULL);',
        'ALTER TABLE items ATTACH PARTITION loose FOR VALUES WITH (MODULUS 2, REMAINDER 1);',
      ]).violations,
    ).toEqual([
      '0001_m.sql: loose получает колонку project_id, а миграция не включает ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, политика scope_app_project_id',
    ]);
    expect(
      check([`${CREATE_ITEMS}\n${PROTECT}`, 'CREATE TABLE child (extra int) INHERITS (items);']).violations,
    ).toEqual([
      '0001_m.sql: child получает колонку project_id, а миграция не включает ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, политика scope_app_project_id',
      'child: колонка project_id есть, а в списке области таблицы нет',
    ]);
  });

  it('секции при RENAME, SET SCHEMA, DETACH PARTITION и DROP родителя: связь с родителем идёт за таблицей', () => {
    const partitioned = (scope: ProjectScope, parent = 'items'): string =>
      `CREATE TABLE ${parent} (id int, project_id uuid NOT NULL) PARTITION BY HASH (project_id);\n` +
      `${scopePolicySql(scope, { tables: [parent] })}\n` +
      `CREATE TABLE items_p0 PARTITION OF ${parent} FOR VALUES WITH (MODULUS 2, REMAINDER 0);\n` +
      scopePolicySql(scope, { tables: ['items_p0'] });
    // Переименована секция — она всё ещё секция таблицы списка.
    expect(check([partitioned(SCOPE), 'ALTER TABLE items_p0 RENAME TO items_part0;']).violations).toEqual([]);
    // Секция перенесена в другую схему — тоже.
    expect(check([partitioned(SCOPE), 'ALTER TABLE items_p0 SET SCHEMA archive;']).violations).toEqual([]);
    // Переименован родитель (список знает новое имя) — секция идёт за ним.
    const goods = scopeOf(['goods']);
    expect(check([partitioned(goods), 'ALTER TABLE items RENAME TO goods;'], {}, goods).violations).toEqual(
      [],
    );
    // Отсоединённая секция с колонкой области — самостоятельная таблица вне списка.
    expect(check([partitioned(SCOPE), 'ALTER TABLE items DETACH PARTITION items_p0;']).violations).toEqual([
      'items_p0: колонка project_id есть, а в списке области таблицы нет',
    ]);
    expect(
      check([partitioned(SCOPE), 'ALTER TABLE items DETACH PARTITION items_p0 CONCURRENTLY;']).violations,
    ).toEqual(['items_p0: колонка project_id есть, а в списке области таблицы нет']);
    // Двойник: отсоединённую и удалённую судить не о чем.
    expect(
      check([partitioned(SCOPE), 'ALTER TABLE items DETACH PARTITION items_p0;\nDROP TABLE items_p0;'])
        .violations,
    ).toEqual([]);
    // Представление, переименованное через ALTER TABLE (сервер это принимает), — судится под новым именем.
    const view = (fix: string): readonly string[] =>
      check([
        `${CREATE_ITEMS}\n${PROTECT}`,
        'CREATE VIEW items_v AS SELECT * FROM items;',
        'ALTER TABLE items_v RENAME TO items_view;',
        fix,
      ]).violations;
    expect(view('ALTER VIEW items_view SET (security_invoker = true);')).toEqual([]);
    expect(view('SELECT 1;')).toEqual([
      '0001_m.sql: представление items_view над данными области без security_invoker = true — политики применяются к его владельцу',
    ]);
    // Удалённый родитель уносит секции с собой (сервер удаляет их вместе с ним).
    const keep = scopeOf(['keep']);
    expect(
      check(
        [
          `CREATE TABLE keep (id int, project_id uuid NOT NULL);\n${scopePolicySql(keep, { tables: ['keep'] })}`,
          partitioned(keep),
          'DROP TABLE items;',
        ],
        {},
        keep,
      ).violations,
    ).toEqual([]);
  });

  it('переименование таблицы переносит её защиту; список обязан знать новое имя', () => {
    const renamed = scopeOf(['goods']);
    expect(
      check(
        [
          `${CREATE_ITEMS}\n${scopePolicySql(renamed, { tables: ['items'] })}`,
          'ALTER TABLE items RENAME TO goods;',
        ],
        {},
        renamed,
      ).violations,
    ).toEqual([]);
    expect(check([`${CREATE_ITEMS}\n${PROTECT}`, 'ALTER TABLE items RENAME TO goods;']).violations).toEqual([
      'items в списке области, а миграции её не создают',
      'goods: колонка project_id есть, а в списке области таблицы нет',
    ]);
  });

  it('файл миграции с BOM в начале (так сохраняют редакторы Windows): первый оператор судится, а не пропадает', () => {
    expect(
      check([
        '\ufeffCREATE TABLE notes (id int, project_id uuid NOT NULL);',
        `\ufeff${CREATE_ITEMS}\n${PROTECT}`,
      ]).violations,
    ).toEqual([
      '0000_m.sql: notes получает колонку project_id, а миграция не включает ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, политика scope_app_project_id',
      'notes: колонка project_id есть, а в списке области таблицы нет',
    ]);
  });

  it('временная таблица не судится; SQL, который не разобран, — нарушение, а не «чисто»', () => {
    expect(
      check([`${CREATE_ITEMS}\n${PROTECT}`, 'CREATE TEMP TABLE scratch (project_id uuid);']).violations,
    ).toEqual([]);
    expect(check([`${CREATE_ITEMS}\n${PROTECT}`, "SELECT 'oops"]).violations).toEqual([
      "0001_m.sql: SQL не разобран (незакрытый литерал '…)",
    ]);
  });
});
