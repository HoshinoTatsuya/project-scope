import { Pool } from 'pg';

import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { SCOPE_PROBLEM } from '../constants/scope-problem.constant';
import { withScope } from '../context/with-scope';
import { scopePolicySql } from '../policy/scope-policy-sql';
import { defineProjectScope } from '../scope/define-project-scope';
import { maintenancePredicateSql } from '../scope/maintenance-predicate-sql';
import { bodiesOf } from '../testing/bodies-of';
import { createScopeTables } from '../testing/create-scope-tables';
import { describeDb } from '../testing/describe-db';
import { problemsOf } from '../testing/problems-of';
import { PROJECT } from '../testing/project.constant';
import { rejectionOf } from '../testing/rejection-of';
import { createScopeTestDatabase } from '../testing/scope-test-database';
import type { ScopeTestDatabase } from '../testing/scope-test-database.type';
import type { ProjectScope } from '../types/project-scope.type';
import type { ScopeColumnType } from '../types/scope-column-type.type';
import { assertScopeReady } from './assert-scope-ready';

/** SQLSTATE отказа Postgres. */
const sqlStateOf = (error: unknown): string | undefined => (error as { code?: string }).code;

/**
 * Изоляция зависит от ВСЕХ отношений и связей с данными области, а не от
 * списка: каждый тест строит обход, которого нет в `scope.tables`, и
 * показывает, что проверка на старте его называет. Всё — под ролью приложения
 * без суперправ и BYPASSRLS, она же владелец таблиц.
 */
describeDb('assertScopeReady: один проход по каталогу [нужен PG_TEST_URL]', () => {
  let database: ScopeTestDatabase;

  beforeAll(async () => {
    database = await createScopeTestDatabase();
  });
  afterAll(async () => {
    await database?.drop();
  });
  // Каждый тест — с пустой базы: проверка судит весь каталог.
  afterEach(async () => {
    await database.admin.query(`DROP OWNED BY ${database.roles.app}`);
  });

  const scopeOf = (
    tables: string[] = ['items', 'notes'],
    columnType: ScopeColumnType = SCOPE_COLUMN_TYPE.uuid,
  ): ProjectScope =>
    defineProjectScope({
      setting: 'app.project_id',
      column: 'project_id',
      columnType,
      tables,
      maintenanceRole: database.roles.maintenance,
    });

  it('контроль: таблицы области из scopePolicySql — готово', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    expect(await problemsOf(database.app, scope)).toBe('ready');
  });

  it('таблица с колонкой области, созданная мимо списка (DO $$ … EXECUTE), — unlisted-table; без доступа роли — не судится', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    await database.app.query(
      `DO $$ BEGIN EXECUTE 'CREATE TABLE leak (id serial, project_id uuid NOT NULL, body text NOT NULL)'; END $$`,
    );
    await withScope(database.appDb, scope, PROJECT.a, (_tx, client) =>
      client.query(`INSERT INTO leak (project_id, body) VALUES ($1, 'секрет A')`, [PROJECT.a]),
    );
    // Утечка настоящая: область B читает строку A.
    expect(
      await withScope(database.appDb, scope, PROJECT.b, async (_tx, client) =>
        (await client.query<{ body: string }>('SELECT body FROM leak')).rows.map((row) => row.body),
      ),
    ).toEqual(['секрет A']);
    await database.admin.query('CREATE TABLE hidden (project_id uuid)');
    try {
      expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.unlistedTable, 'leak']]);
    } finally {
      await database.admin.query('DROP TABLE hidden');
    }
  });

  it('материализованное представление над данными области — materialized-view: REFRESH в области A выносит её строки всем', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    await database.app.query(`
      CREATE MATERIALIZED VIEW items_mv AS SELECT * FROM items WITH NO DATA;
      CREATE MATERIALIZED VIEW items_count AS SELECT count(*) AS n FROM items;
    `);
    await withScope(database.appDb, scope, PROJECT.a, (_tx, client) =>
      client.query('REFRESH MATERIALIZED VIEW items_mv'),
    );
    expect(await bodiesOf(database.app, 'items_mv')).toEqual(['a.1', 'a.2']);
    // Чужое представление без права роли приложения на чтение ей ничего не выносит.
    await database.admin.query('CREATE MATERIALIZED VIEW admin_mv AS SELECT * FROM items');
    try {
      expect(await problemsOf(database.app, scope)).toEqual([
        [SCOPE_PROBLEM.materializedView, 'items_count'],
        [SCOPE_PROBLEM.materializedView, 'items_mv'],
      ]);
    } finally {
      await database.admin.query('DROP MATERIALIZED VIEW admin_mv');
    }
  });

  it('представление чужого владельца без security_invoker — view-not-invoker; с ним — нет; цепочка представлений судится целиком', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    // Владелец — суперпользователь (миграции под ним): политики применяются к нему, то есть ни одна.
    await database.admin.query(`
      CREATE VIEW v_owner AS SELECT * FROM items;
      CREATE VIEW v_invoker WITH (security_invoker = on) AS SELECT * FROM items;
      CREATE VIEW v_chain AS SELECT count(*) AS n FROM v_invoker;
      CREATE VIEW v_chain_invoker WITH (security_invoker) AS SELECT count(*) AS n FROM v_invoker;
      GRANT SELECT ON v_owner, v_invoker, v_chain, v_chain_invoker TO ${database.roles.app};
    `);
    try {
      expect(await problemsOf(database.app, scope)).toEqual([
        [SCOPE_PROBLEM.viewNotInvoker, 'v_chain'],
        [SCOPE_PROBLEM.viewNotInvoker, 'v_owner'],
      ]);
    } finally {
      await database.admin.query('DROP VIEW v_chain_invoker, v_chain, v_invoker, v_owner');
    }
  });

  it('внешний ключ между таблицами области без пары колонок — foreign-key-across-scopes; с парой — готово и каскад не трогает чужую область', async () => {
    const scope = scopeOf(['parents', 'children']);
    await database.app.query(`
      CREATE TABLE parents (id serial PRIMARY KEY, project_id uuid NOT NULL, body text NOT NULL);
      CREATE TABLE children (id serial PRIMARY KEY, project_id uuid NOT NULL,
        parent_id int NOT NULL REFERENCES parents (id) ON DELETE CASCADE, body text NOT NULL);
      ${scopePolicySql(scope)}
    `);
    expect(await problemsOf(database.app, scope)).toEqual([
      [SCOPE_PROBLEM.foreignKeyAcrossScopes, 'children'],
    ]);
    await database.app.query(`
      ALTER TABLE children DROP CONSTRAINT children_parent_id_fkey;
      ALTER TABLE parents ADD UNIQUE (project_id, id);
      ALTER TABLE children ADD FOREIGN KEY (project_id, parent_id) REFERENCES parents (project_id, id)
        ON DELETE CASCADE ON UPDATE CASCADE;
    `);
    expect(await problemsOf(database.app, scope)).toBe('ready');
    const parentId = await withScope(database.appDb, scope, PROJECT.a, async (_tx, client) => {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO parents (project_id, body) VALUES ($1, 'parent A') RETURNING id`,
        [PROJECT.a],
      );
      return rows[0]?.id as number;
    });
    await database.admin.query(`INSERT INTO parents (id, project_id, body) VALUES (1000, $1, 'parent B')`, [
      PROJECT.b,
    ]);
    await database.admin.query(
      `INSERT INTO children (project_id, parent_id, body) VALUES ($1, 1000, 'child B')`,
      [PROJECT.b],
    );
    // Область B не отличит «строка A есть» от «строки нет»: оба — нарушение ключа.
    const insertChild = (parent: number) =>
      rejectionOf(
        withScope(database.appDb, scope, PROJECT.b, (_tx, client) =>
          client.query(`INSERT INTO children (project_id, parent_id, body) VALUES ($1, $2, 'x')`, [
            PROJECT.b,
            parent,
          ]),
        ),
      );
    expect([sqlStateOf(await insertChild(parentId)), sqlStateOf(await insertChild(parentId + 5000))]).toEqual(
      ['23503', '23503'],
    );
    await withScope(database.appDb, scope, PROJECT.a, (_tx, client) => client.query('DELETE FROM parents'));
    expect(await bodiesOf(database.admin, 'children')).toEqual(['child B']);
  });

  it('право TRUNCATE: scopePolicySql отзывает его у владельца, TRUNCATE в области — отказ сервера; роль с GRANT ALL — truncate-privilege', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    const refused = await rejectionOf(
      withScope(database.appDb, scope, PROJECT.a, (_tx, client) => client.query('TRUNCATE items')),
    );
    expect(sqlStateOf(refused)).toBe('42501');
    expect(await bodiesOf(database.admin, 'items')).toEqual(['a.1', 'a.2', 'b.1']);
    expect(await problemsOf(database.reader, scope)).toBe('ready');
    await database.app.query(`GRANT ALL ON notes TO ${database.roles.reader}`);
    expect(await problemsOf(database.reader, scope)).toEqual([[SCOPE_PROBLEM.truncatePrivilege, 'notes']]);
  });

  it('роль входа (session_user) с BYPASSRLS под ролью приложения (ALTER ROLE … SET role) — отказ', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    const login = await database.extraRole('login', 'NOSUPERUSER BYPASSRLS');
    await database.admin.query(`GRANT ${database.roles.app} TO ${login.role}`);
    await database.admin.query(`ALTER ROLE ${login.role} SET role = '${database.roles.app}'`);
    const { rows } = await login.pool.query<{ current: string; session: string }>(
      'SELECT current_user::text AS current, session_user::text AS session',
    );
    expect(rows[0]).toEqual({ current: database.roles.app, session: login.role });
    expect(await problemsOf(login.pool, scope)).toEqual([[SCOPE_PROBLEM.bypassRls, null]]);
    // Политика на роль, в которую входит только роль входа, — тоже на сессию: SET ROLE NONE её включает.
    const reports = await database.extraRole('reports');
    await database.admin.query(`GRANT ${reports.role} TO ${login.role}`);
    await database.app.query(`CREATE POLICY reports_all ON items TO ${reports.role} USING (true)`);
    expect(await problemsOf(login.pool, scope)).toEqual([
      [SCOPE_PROBLEM.bypassRls, null],
      [SCOPE_PROBLEM.foreignPolicy, 'items'],
    ]);
    expect(await problemsOf(database.app, scope)).toBe('ready');
  });

  it('членство во встроенных ролях доступа к программам и файлам сервера — escalation', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    for (const builtin of ['pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files']) {
      const member = await database.extraRole(builtin.replaceAll('_', ''));
      await database.admin.query(`GRANT ${builtin} TO ${member.role}`);
      expect([builtin, await problemsOf(member.pool, scope)]).toEqual([
        builtin,
        [[SCOPE_PROBLEM.escalation, null]],
      ]);
    }
  });

  it('колонка области text с недетерминированной колацией — nondeterministic-collation', async () => {
    const scope = scopeOf(['tenants_data'], SCOPE_COLUMN_TYPE.text);
    await database.app.query(`
      CREATE COLLATION ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
      CREATE TABLE tenants_data (id serial PRIMARY KEY, project_id text COLLATE ci NOT NULL, body text NOT NULL);
      ${scopePolicySql(scope)}
    `);
    await database.admin.query(
      `INSERT INTO tenants_data (project_id, body) VALUES ('acme', 'acme'), ('ACME', 'ACME — другая область')`,
    );
    expect(
      await withScope(
        database.appDb,
        scope,
        'acme',
        async (_tx, client) =>
          (await client.query<{ body: string }>('SELECT body FROM tenants_data ORDER BY body')).rows.length,
      ),
    ).toBe(2);
    expect(await problemsOf(database.app, scope)).toEqual([
      [SCOPE_PROBLEM.nondeterministicCollation, 'tenants_data'],
    ]);
  });

  it('наследник таблицы области (INHERITS) без своей защиты — отказ по наследнику; с защитой — готово', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    await database.app.query('CREATE TABLE items_child () INHERITS (items)');
    expect(await problemsOf(database.app, scope)).toEqual([
      [SCOPE_PROBLEM.policyMissing, 'items/items_child'],
      [SCOPE_PROBLEM.rlsDisabled, 'items/items_child'],
      [SCOPE_PROBLEM.truncatePrivilege, 'items/items_child'],
    ]);
    await database.app.query(scopePolicySql(scope, { tables: ['items_child'] }));
    expect(await problemsOf(database.app, scope)).toBe('ready');
  });

  it('правило на данных области — rewrite-rule', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    await database.app.query(
      'CREATE TABLE sink (id int); CREATE RULE wipe AS ON INSERT TO sink DO ALSO DELETE FROM items',
    );
    expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.rewriteRule, 'sink']]);
  });

  it('политика сквозного доступа прежней формы (USING true) — policy-mismatch', async () => {
    const scope = scopeOf();
    const predicate = maintenancePredicateSql(scope);
    await createScopeTables(database, scope, scopePolicySql(scope).replaceAll(predicate, 'true'));
    expect(await problemsOf(database.app, scope)).toEqual([
      [SCOPE_PROBLEM.policyMismatch, 'items'],
      [SCOPE_PROBLEM.policyMismatch, 'notes'],
    ]);
  });

  it('пул только для чтения — готово; эталон с другого пула (canonicalFrom) — готово и без права TEMP', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    const readOnly = new Pool({
      connectionString: database.urls.app,
      max: 1,
      options: '-c default_transaction_read_only=on',
    });
    try {
      const { rows } = await readOnly.query<{ ro: string }>(
        "SELECT current_setting('transaction_read_only') AS ro",
      );
      expect(rows[0]?.ro).toBe('on');
      expect(await problemsOf(readOnly, scope)).toBe('ready');
    } finally {
      await readOnly.end();
    }
    const { rows } = await database.admin.query<{ name: string }>('SELECT current_database() AS name');
    const name = rows[0]?.name as string;
    await database.admin.query(`REVOKE TEMP ON DATABASE ${name} FROM PUBLIC`);
    try {
      const reader = database.pool('reader', 1);
      expect(await problemsOf(reader, scope)).toEqual([[SCOPE_PROBLEM.undetermined, null]]);
      expect(await problemsOf(reader, scope, { canonicalFrom: database.app })).toBe('ready');
      const closed = new Pool({ connectionString: database.urls.app, max: 1 });
      await closed.end();
      expect(await problemsOf(database.app, scope, { canonicalFrom: closed })).toEqual([
        [SCOPE_PROBLEM.undetermined, null],
      ]);
    } finally {
      await database.admin.query(`GRANT TEMP ON DATABASE ${name} TO PUBLIC`);
    }
  });

  it('проверка не уложилась в timeoutMs — отказ undetermined, соединение проверки уничтожено, а не оставлено занятым', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    // Пул занят: соединение, выданное уже после потолка, уничтожается сразу.
    const busy = database.pool('app', 1);
    const held = await busy.connect();
    expect(await problemsOf(busy, scope, { timeoutMs: 200 })).toEqual([[SCOPE_PROBLEM.undetermined, null]]);
    held.release();
    // Следующий возврат соединения — то, что пул выдал проверке после потолка: с ошибкой, то есть уничтожено.
    const lateRelease = await new Promise((resolve) => busy.once('release', resolve));
    expect(lateRelease).toBeInstanceOf(Error);
    expect(await problemsOf(busy, scope)).toBe('ready');
    // Запрос проверки висит на блокировке каталога: по потолку соединение уничтожается посреди запроса.
    const stuck = database.pool('app', 1);
    const locker = await database.admin.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE pg_catalog.pg_policy IN ACCESS EXCLUSIVE MODE');
      expect(await problemsOf(stuck, scope, { timeoutMs: 300 })).toEqual([
        [SCOPE_PROBLEM.undetermined, null],
      ]);
      expect(stuck.totalCount).toBe(0);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
    await expect(assertScopeReady(busy, scope, { timeoutMs: 0 })).rejects.toThrow('timeoutMs');
  });

  it('совпавшие имена политик двух областей на одной таблице — отказ сервера при миграции, а не тихая подмена', async () => {
    const first = defineProjectScope({
      setting: 'app.a_b',
      column: 'project_id',
      columnType: 'uuid',
      tables: ['shared'],
    });
    const second = defineProjectScope({
      setting: 'app_a.b',
      column: 'project_id',
      columnType: 'uuid',
      tables: ['shared'],
    });
    expect(first.policyName).toBe(second.policyName);
    await database.app.query(`CREATE TABLE shared (project_id uuid NOT NULL); ${scopePolicySql(first)}`);
    expect(sqlStateOf(await rejectionOf(database.app.query(scopePolicySql(second))))).toBe('42710');
  });
});
