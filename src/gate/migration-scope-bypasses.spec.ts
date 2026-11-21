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
    maintenanceRole: 'app_maintenance',
  });

const SCOPE = scopeOf(['items']);
const INIT = `CREATE TABLE "items" ("id" serial PRIMARY KEY, "project_id" uuid NOT NULL, "body" text);\n${scopePolicySql(SCOPE)}`;
const PREDICATE = scopePredicateSql(SCOPE);
const REASON = 'агрегат без строк проектов: читает только роль сквозного доступа';

const check = (migrations: string[], options: MigrationScopeOptions = {}, scope: ProjectScope = SCOPE) =>
  migrationScopeViolations(
    scope,
    [INIT, ...migrations].map((sql, index) => ({ name: `000${index}_m.sql`, sql })),
    options,
  ).violations;

/**
 * Каждый случай — история миграций, после которой изоляция на живой базе
 * снята или обойдена. Гейт читает текст — рубеж против ошибок, а не против
 * умысла; но каждая из этих форм пишется и по ошибке.
 */
describe('migrationScopeViolations: обходы защиты', () => {
  it('контроль: защита из пакета (с политикой сквозного доступа и отзывом TRUNCATE) — чисто', () => {
    expect(check([])).toEqual([]);
  });

  const FOREIGN = ' — складывается с политикой области через OR и расширяет доступ';
  const MAINTENANCE = ' — роль сквозного доступа видит все строки только без контекста области';

  it.each([
    [
      'чужая разрешающая политика USING (true)',
      'CREATE POLICY reports ON items FOR SELECT USING (true);',
      `0001_m.sql: разрешающая политика reports на items${FOREIGN}`,
    ],
    [
      'вторая политика «как сквозного доступа» на PUBLIC',
      'CREATE POLICY scope_app_project_id_maintenance2 ON items TO PUBLIC USING (true);',
      `0001_m.sql: разрешающая политика scope_app_project_id_maintenance2 на items${FOREIGN}`,
    ],
    [
      'политика сквозного доступа прежней формы (USING true)',
      'DROP POLICY scope_app_project_id_maintenance ON items; CREATE POLICY scope_app_project_id_maintenance ON items TO app_maintenance USING (true) WITH CHECK (true);',
      `0001_m.sql: политика scope_app_project_id_maintenance на items не та, что строит пакет${MAINTENANCE}`,
    ],
    [
      'политика сквозного доступа на PUBLIC',
      `DROP POLICY scope_app_project_id_maintenance ON items; CREATE POLICY scope_app_project_id_maintenance ON items TO PUBLIC USING (NULLIF(current_setting('app.project_id', true), '') IS NULL) WITH CHECK (NULLIF(current_setting('app.project_id', true), '') IS NULL);`,
      `0001_m.sql: политика scope_app_project_id_maintenance на items не та, что строит пакет${MAINTENANCE}`,
    ],
  ])('%s — нарушение к концу истории', (_label, sql, message) => {
    expect(check([sql])).toEqual([message]);
  });

  it('чужая политика, снятая позже, и ограничивающая политика — чисто', () => {
    expect(
      check([
        'CREATE POLICY reports ON items FOR SELECT USING (true);',
        'DROP POLICY reports ON items; CREATE POLICY narrow ON items AS RESTRICTIVE USING (id > 0);',
      ]),
    ).toEqual([]);
  });

  it('эталон, спрятанный в литерал WITH CHECK, — политика не та (сравнивается текст целиком)', () => {
    const hidden = `DROP POLICY scope_app_project_id ON items; CREATE POLICY scope_app_project_id ON items AS PERMISSIVE FOR ALL TO PUBLIC USING (true) WITH CHECK (true OR $x$using (${PREDICATE}) with check (${PREDICATE})$x$ <> '');`;
    expect(check([hidden])).toEqual([
      '0001_m.sql: политика scope_app_project_id на items не та: выражение не то, что строит пакет (USING и WITH CHECK)',
      '0001_m.sql: items — защита области снята: нет политика scope_app_project_id',
      'items в списке области, а к концу миграций защита не полная',
    ]);
    // Лишнее условие перед эталоном в USING: хвост «using (эталон) with check (эталон)» не совпадает.
    const prefixed = `DROP POLICY scope_app_project_id ON items; CREATE POLICY scope_app_project_id ON items USING (true OR ${PREDICATE}) WITH CHECK (${PREDICATE});`;
    expect(check([prefixed])[0]).toBe(
      '0001_m.sql: политика scope_app_project_id на items не та: выражение не то, что строит пакет (USING и WITH CHECK)',
    );
  });

  it('SELECT … INTO — новая таблица, которую разбор не понял: в notScoped с причиной или нарушение', () => {
    expect(check(['SELECT * INTO items_copy FROM items;'])).toEqual([
      '0001_m.sql: SELECT … INTO items_copy не разобран (новая таблица из запроса) — есть ли колонка project_id, не определить; внесите таблицу в список области или в notScoped с причиной',
    ]);
    expect(check(['SELECT * INTO items_copy FROM items;'], { notScoped: { items_copy: REASON } })).toEqual(
      [],
    );
    expect(
      check([
        'SELECT * INTO TEMP scratch FROM items;',
        'WITH x AS (SELECT 1) INSERT INTO items (body) SELECT 1 FROM x;',
      ]),
    ).toEqual([]);
  });

  it('материализованное представление над данными области — нарушение; notScoped или снятое позже — чисто', () => {
    const matview = 'CREATE MATERIALIZED VIEW items_mv AS SELECT * FROM items;';
    expect(check([matview])).toEqual([
      '0001_m.sql: материализованное представление items_mv над данными области — у него нет RLS, REFRESH сохраняет строки, видимые обновившему, для всех',
    ]);
    expect(check([matview], { notScoped: { items_mv: REASON } })).toEqual([]);
    expect(check([matview, 'DROP MATERIALIZED VIEW items_mv;'])).toEqual([]);
    expect(
      check(['CREATE TABLE plain (id int); CREATE MATERIALIZED VIEW plain_mv AS SELECT * FROM plain;']),
    ).toEqual([]);
  });

  it('представление без security_invoker — нарушение; с ним (в любой записи) или исправленное ALTER VIEW — чисто; цепочка судится', () => {
    expect(check(['CREATE VIEW items_v AS SELECT * FROM items;'])).toEqual([
      '0001_m.sql: представление items_v над данными области без security_invoker = true — политики применяются к его владельцу',
    ]);
    for (const invoker of [
      'security_invoker',
      'security_invoker = true',
      "security_invoker='on'",
      'security_barrier, security_invoker=1',
    ]) {
      expect([invoker, check([`CREATE VIEW items_v WITH (${invoker}) AS SELECT * FROM items;`])]).toEqual([
        invoker,
        [],
      ]);
    }
    expect(
      check(['CREATE VIEW items_v WITH (security_invoker = false) AS SELECT * FROM items;']),
    ).toHaveLength(1);
    expect(
      check([
        'CREATE VIEW items_v AS SELECT * FROM items;',
        'ALTER VIEW items_v SET (security_invoker = true);',
      ]),
    ).toEqual([]);
    expect(
      check([
        'CREATE VIEW items_v WITH (security_invoker) AS SELECT * FROM items;',
        'ALTER VIEW items_v RESET (security_invoker);',
      ]),
    ).toHaveLength(1);
    expect(
      check([
        'CREATE VIEW items_v WITH (security_invoker) AS SELECT * FROM items; CREATE VIEW totals AS SELECT count(*) FROM items_v;',
      ]),
    ).toEqual([
      '0001_m.sql: представление totals над данными области без security_invoker = true — политики применяются к его владельцу',
    ]);
  });

  it('CREATE SCHEMA с элементами, ROLLBACK, standard_conforming_strings, UESCAPE — то, что разбор читает не так, как сервер, — нарушение', () => {
    expect(check(['CREATE SCHEMA shadow CREATE TABLE leak (id int, project_id uuid);'])).toEqual([
      '0001_m.sql: CREATE SCHEMA с элементами (CREATE TABLE … внутри) гейт не разбирает — разнесите на отдельные операторы',
    ]);
    expect(check(['CREATE SCHEMA IF NOT EXISTS archive AUTHORIZATION app;'])).toEqual([]);
    expect(
      check([
        'ALTER TABLE items NO FORCE ROW LEVEL SECURITY; BEGIN; ALTER TABLE items FORCE ROW LEVEL SECURITY; ROLLBACK;',
      ])[0],
    ).toMatch(/^0001_m\.sql: ROLLBACK в миграции/);
    const scsOff = [
      'SET standard_conforming_strings = off',
      "SELECT 'a\\''",
      'ALTER TABLE items DISABLE ROW LEVEL SECURITY',
      "SELECT 'b\\''",
    ].join(';\n');
    expect(check([scsOff])[0]).toMatch(/^0001_m\.sql: standard_conforming_strings в миграции/);
    expect(check(['CREATE TABLE leak (id int, U&"d!0061t!+000061" UESCAPE \'!\' int);'])[0]).toMatch(
      /UESCAPE/,
    );
  });

  it('колонка области юникодным именем U&"…" — распознаётся (сервер раскрывает её в project_id)', () => {
    expect(check(['CREATE TABLE leak (id int, U&"proj\\0065ct_id" uuid);'])).toEqual([
      '0001_m.sql: leak получает колонку project_id, а миграция не включает ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, политика scope_app_project_id',
      'leak: колонка project_id есть, а в списке области таблицы нет',
    ]);
  });

  it('SET SCHEMA уводит таблицу из-под имени списка — нарушение; CREATE TABLE IF NOT EXISTS существующей — не сбрасывает её защиту', () => {
    expect(check(['CREATE SCHEMA archive;', 'ALTER TABLE items SET SCHEMA archive;'])).toEqual([
      'items в списке области, а миграции её не создают',
      'archive.items: колонка project_id есть, а в списке области таблицы нет',
    ]);
    expect(
      check([
        'CREATE TABLE IF NOT EXISTS items ("id" serial PRIMARY KEY, "project_id" uuid NOT NULL, "body" text);',
      ]),
    ).toEqual([]);
  });

  it('правило, GRANT роли сквозного доступа и роли доступа к файлам сервера, BYPASSRLS, SECURITY DEFINER над таблицей области — нарушение', () => {
    expect(
      check([
        'CREATE TABLE sink (id int);',
        'CREATE RULE wipe AS ON INSERT TO sink DO ALSO DELETE FROM items;',
      ]),
    ).toEqual([
      '0002_m.sql: правило wipe на sink касается данных области — исполняется правами владельца таблицы; замените триггером',
    ]);
    expect(
      check([
        'CREATE TABLE sink (id int);',
        'CREATE RULE wipe AS ON INSERT TO sink DO ALSO DELETE FROM items;',
        'DROP RULE wipe ON sink;',
      ]),
    ).toEqual([]);
    expect(check(['GRANT app_maintenance TO app;'])).toEqual([
      '0001_m.sql: GRANT app_maintenance — членство в роли сквозного доступа или доступа к файлам сервера снимает изоляцию одной командой',
    ]);
    expect(check(['GRANT pg_execute_server_program, reports TO app;'])).toHaveLength(1);
    expect(check(['GRANT SELECT ON items TO app_maintenance; GRANT reports TO app;'])).toEqual([]);
    expect(check(['ALTER ROLE app BYPASSRLS;'])).toEqual([
      '0001_m.sql: роль с BYPASSRLS — RLS к ней не применяется',
    ]);
    expect(check(['CREATE ROLE app2 LOGIN NOSUPERUSER NOBYPASSRLS;'])).toEqual([]);
    expect(
      check([
        'CREATE FUNCTION all_items() RETURNS SETOF items LANGUAGE sql SECURITY DEFINER AS $$ SELECT * FROM items $$;',
      ]),
    ).toEqual([
      '0001_m.sql: функция SECURITY DEFINER над таблицей области — исполняется правами владельца, который политик не проходит',
    ]);
    expect(
      check([
        'CREATE FUNCTION now_utc() RETURNS timestamptz LANGUAGE sql SECURITY DEFINER AS $$ SELECT now() $$;',
      ]),
    ).toEqual([]);
    expect(check(['ALTER FUNCTION all_items() SECURITY DEFINER;'])).toHaveLength(1);
  });

  it('внешний ключ на таблицу области без пары колонок области — нарушение; с парой, исправленный позже или на таблицу вне области — чисто', () => {
    const scope = scopeOf(['parents', 'children']);
    const parents = `CREATE TABLE parents (id serial PRIMARY KEY, project_id uuid NOT NULL, UNIQUE (project_id, id));\n${scopePolicySql(scope, { tables: ['parents'] })}`;
    const children = (keys: string) =>
      `CREATE TABLE children (id serial PRIMARY KEY, project_id uuid NOT NULL, parent_id int NOT NULL${keys});\n${scopePolicySql(scope, { tables: ['children'] })}`;
    const run = (migrations: string[]) =>
      migrationScopeViolations(
        scope,
        migrations.map((sql, index) => ({ name: `000${index}_m.sql`, sql })),
      ).violations;
    expect(run([parents, children(' REFERENCES parents (id) ON DELETE CASCADE')])).toEqual([
      '0001_m.sql: внешний ключ children_parent_id_fkey children → parents без пары колонок project_id — проверка ключа и каскады идут мимо RLS; ключ (project_id, …) REFERENCES parents (project_id, …)',
    ]);
    expect(
      run([parents, children(', CONSTRAINT fk FOREIGN KEY (parent_id) REFERENCES parents')])[0],
    ).toContain('внешний ключ fk children → parents без пары колонок project_id — проверка ключа');
    expect(
      run([parents, children(', FOREIGN KEY (project_id, parent_id) REFERENCES parents (project_id, id)')]),
    ).toEqual([]);
    // Колонка области в ключе есть, но в паре не с колонкой области родителя.
    expect(
      run([parents, children(', FOREIGN KEY (project_id, parent_id) REFERENCES parents (id, project_id)')]),
    ).toHaveLength(1);
    // Форма drizzle-kit: отдельным ALTER TABLE, схема и колонки без пробела.
    expect(
      run([
        parents,
        children(''),
        'ALTER TABLE "children" ADD CONSTRAINT "children_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."parents"("id") ON DELETE cascade;',
      ]),
    ).toHaveLength(1);
    expect(
      run([
        parents,
        children(' REFERENCES parents (id)'),
        'ALTER TABLE children DROP CONSTRAINT children_parent_id_fkey, ADD FOREIGN KEY (project_id, parent_id) REFERENCES parents (project_id, id);',
      ]),
    ).toEqual([]);
    expect(
      run([
        parents,
        children(''),
        'CREATE TABLE kinds (id int PRIMARY KEY);',
        'ALTER TABLE children ADD COLUMN kind_id int REFERENCES kinds (id);',
      ]),
    ).toEqual([]);
    expect(
      run([parents, children(''), 'ALTER TABLE children ADD COLUMN other_id int REFERENCES parents (id);']),
    ).toHaveLength(1);
  });

  it('колонка области переименована или снята — таблица больше не защищена этой областью: нарушение для таблицы списка', () => {
    expect(check(['ALTER TABLE items RENAME COLUMN project_id TO owner_id;'])).toEqual([
      'items в списке области, а колонки project_id в ней нет',
    ]);
    expect(check(['ALTER TABLE items DROP COLUMN project_id;'])).toEqual([
      'items в списке области, а колонки project_id в ней нет',
    ]);
    expect(check(['ALTER TABLE items DROP COLUMN body;'])).toEqual([]);
    const plain = 'CREATE TABLE plain (id int, owner_id uuid);';
    expect(check([plain, 'ALTER TABLE plain RENAME COLUMN owner_id TO project_id;'])).toEqual([
      '0002_m.sql: plain получает колонку project_id, а миграция не включает ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY, политика scope_app_project_id',
      'plain: колонка project_id есть, а в списке области таблицы нет',
    ]);
  });

  it('наследник таблицы области от предка без колонки области — нарушение; предок с колонкой или NO INHERIT — чисто', () => {
    const scope = scopeOf(['documents']);
    const protect = scopePolicySql(scope);
    const run = (migrations: string[]) =>
      migrationScopeViolations(
        scope,
        migrations.map((sql, index) => ({ name: `000${index}_m.sql`, sql })),
      ).violations;
    const ancestor = 'CREATE TABLE entity (id serial, title text);';
    const child = `CREATE TABLE documents (project_id uuid NOT NULL, body text) INHERITS (entity);\n${protect}`;
    const message =
      '0001_m.sql: documents наследует entity без колонки project_id — запрос к entity читает и меняет строки documents всех областей, TRUNCATE стирает их';
    expect(run([ancestor, child])).toEqual([message]);
    expect(run([ancestor, child, 'ALTER TABLE documents NO INHERIT entity;'])).toEqual([]);
    expect(
      run([
        ancestor,
        `CREATE TABLE documents (project_id uuid NOT NULL, body text);\n${protect}`,
        'ALTER TABLE documents INHERIT entity;',
      ]),
    ).toEqual([
      '0002_m.sql: documents наследует entity без колонки project_id — запрос к entity читает и меняет строки documents всех областей, TRUNCATE стирает их',
    ]);
    // Двойник: предок — сама таблица области.
    const both = scopeOf(['documents', 'archive']);
    expect(
      migrationScopeViolations(both, [
        {
          name: '0000_m.sql',
          sql: `CREATE TABLE documents (project_id uuid NOT NULL);\nCREATE TABLE archive (note text) INHERITS (documents);\n${scopePolicySql(both)}`,
        },
      ]).violations,
    ).toEqual([]);
  });

  it('членство в роли сквозного доступа через CREATE ROLE … IN ROLE / ROLE и ALTER GROUP, REPLICATION — нарушение; двойники — чисто', () => {
    for (const sql of [
      'CREATE ROLE helper IN ROLE app_maintenance;',
      'CREATE USER helper LOGIN IN GROUP reports, app_maintenance;',
      'CREATE ROLE app_maintenance ROLE app;',
      'CREATE ROLE app_maintenance NOLOGIN ADMIN app;',
      'ALTER GROUP app_maintenance ADD USER app;',
      'CREATE ROLE pg_like IN ROLE pg_execute_server_program;',
      'ALTER ROLE app REPLICATION;',
      'CREATE ROLE replicator LOGIN REPLICATION;',
    ]) {
      expect([sql, check([sql])]).toEqual([sql, [expect.any(String)]]);
    }
    for (const sql of [
      "CREATE ROLE app_maintenance LOGIN PASSWORD 'x' NOSUPERUSER NOBYPASSRLS NOREPLICATION;",
      'CREATE ROLE helper IN ROLE reports;',
      'ALTER GROUP reports ADD USER app;',
      'ALTER ROLE app NOREPLICATION;',
      'CREATE ROLE reports ROLE app;',
    ]) {
      expect([sql, check([sql])]).toEqual([sql, []]);
    }
  });

  it('переход политики сквозного доступа так, как его пишет drizzle-kit (ALTER POLICY … TO … USING … WITH CHECK), — чисто; ALTER в чужую форму — нарушение', () => {
    const maintenance = `NULLIF(current_setting('app.project_id', true), '') IS NULL`;
    const oldForm =
      'DROP POLICY scope_app_project_id_maintenance ON items; CREATE POLICY "scope_app_project_id_maintenance" ON "items" AS PERMISSIVE FOR ALL TO "app_maintenance" USING (true) WITH CHECK (true);';
    expect(
      check([
        oldForm,
        `ALTER POLICY "scope_app_project_id_maintenance" ON "items" TO "app_maintenance" USING (${maintenance}) WITH CHECK (${maintenance});`,
      ]),
    ).toEqual([]);
    expect(
      check([
        `ALTER POLICY "scope_app_project_id_maintenance" ON "items" TO public USING (${maintenance}) WITH CHECK (${maintenance});`,
      ]),
    ).toEqual([
      '0001_m.sql: политика scope_app_project_id_maintenance на items не та, что строит пакет — роль сквозного доступа видит все строки только без контекста области',
    ]);
    expect(
      check([
        'CREATE POLICY reports ON items USING (true);',
        'ALTER POLICY reports ON items RENAME TO reports_all;',
      ]),
    ).toEqual([
      '0002_m.sql: разрешающая политика reports_all на items — складывается с политикой области через OR и расширяет доступ',
    ]);
    expect(check([`ALTER POLICY scope_app_project_id ON items USING (${PREDICATE});`])).toEqual([]);
  });

  it('внешний ключ без списка колонок родителя — по первичному ключу родителя', () => {
    const scope = scopeOf(['parents', 'children']);
    const run = (parentKey: string) =>
      migrationScopeViolations(scope, [
        {
          name: '0000_m.sql',
          sql:
            `CREATE TABLE parents (id int, project_id uuid NOT NULL, ${parentKey});\n` +
            'CREATE TABLE children (id int, project_id uuid NOT NULL, parent_id int,\n' +
            '  FOREIGN KEY (project_id, parent_id) REFERENCES parents);\n' +
            scopePolicySql(scope),
        },
      ]).violations;
    expect(run('PRIMARY KEY (project_id, id)')).toEqual([]);
    expect(run('PRIMARY KEY (id)')).toHaveLength(1);
  });

  it('ALTER VIEW SET/RESET security_invoker, правило на таблице и на представлении области, короткая причина notScoped — точные ответы', () => {
    const view = 'CREATE VIEW items_v WITH (security_invoker) AS SELECT * FROM items;';
    const invokerOff =
      '0001_m.sql: представление items_v над данными области без security_invoker = true — политики применяются к его владельцу';
    expect(check([view, 'ALTER VIEW items_v RESET (security_invoker);'])).toEqual([invokerOff]);
    expect(check([view, 'ALTER VIEW items_v SET (security_invoker = false);'])).toEqual([invokerOff]);
    expect(check([view, 'ALTER VIEW items_v SET (security_barrier = true);'])).toEqual([]);
    expect(check(['CREATE RULE keep AS ON DELETE TO items DO INSTEAD NOTHING;'])).toEqual([
      '0001_m.sql: правило keep на items касается данных области — исполняется правами владельца таблицы; замените триггером',
    ]);
    expect(check([view, 'CREATE RULE v_ins AS ON INSERT TO items_v DO INSTEAD NOTHING;'])).toEqual([
      '0002_m.sql: правило v_ins на items_v касается данных области — исполняется правами владельца таблицы; замените триггером',
    ]);
    expect(
      check([
        'CREATE TABLE sink (id int); CREATE TABLE log (id int);',
        'CREATE RULE copy AS ON INSERT TO sink DO ALSO INSERT INTO log VALUES (1);',
      ]),
    ).toEqual([]);
    expect(check(['SELECT * INTO copy FROM items;'], { notScoped: { copy: 'короткая' } })).toEqual([
      'допущение copy: причина короче 20 символов — объясните, почему',
    ]);
  });
});
