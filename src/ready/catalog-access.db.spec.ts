import { FaultProxy } from '@hoshinotatsuya/fault-kit/tcp';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { SCOPE_PROBLEM } from '../constants/scope-problem.constant';
import { withScope } from '../context/with-scope';
import { scopePolicySql } from '../policy/scope-policy-sql';
import { defineProjectScope } from '../scope/define-project-scope';
import { bodiesOf } from '../testing/bodies-of';
import { createScopeTables } from '../testing/create-scope-tables';
import { describeDb } from '../testing/describe-db';
import { problemsOf } from '../testing/problems-of';
import { PROJECT } from '../testing/project.constant';
import { createScopeTestDatabase } from '../testing/scope-test-database';
import type { ScopeTestDatabase } from '../testing/scope-test-database.type';
import type { ProjectScope } from '../types/project-scope.type';
import type { ScopeColumnType } from '../types/scope-column-type.type';
import { assertScopeReady } from './assert-scope-ready';

/**
 * Все пути, которыми роль сессии добирается до данных области мимо политик:
 * предок по наследованию, права на колонки, роль без INHERIT, REPLICATION,
 * EXECUTE на функции чтения файлов, каскад из общей таблицы. У каждого
 * детектора рядом — легитимный двойник, на котором отказа быть не должно.
 * Всё — под ролью приложения без суперправ и BYPASSRLS.
 */
describeDb('assertScopeReady: пути доступа к данным области [нужен PG_TEST_URL]', () => {
  let database: ScopeTestDatabase;

  beforeAll(async () => {
    database = await createScopeTestDatabase();
  });
  afterAll(async () => {
    await database?.drop();
  });
  afterEach(async () => {
    await database.admin.query(`DROP OWNED BY ${database.roles.app}`);
  });

  const scopeOf = (
    tables: string[] = ['items', 'notes'],
    columnType: ScopeColumnType = SCOPE_COLUMN_TYPE.uuid,
    column = 'project_id',
  ): ProjectScope =>
    defineProjectScope({
      setting: 'app.project_id',
      column,
      columnType,
      tables,
      maintenanceRole: database.roles.maintenance,
    });

  it('предок по наследованию без колонки области — inheritance-ancestor; без прав на него — готово', async () => {
    const scope = scopeOf(['documents']);
    await database.app.query(`
      CREATE TABLE entity (id serial, title text);
      CREATE TABLE documents (project_id uuid NOT NULL, body text) INHERITS (entity);
      ${scopePolicySql(scope)}
    `);
    await database.admin.query(
      `INSERT INTO documents (title, project_id, body) VALUES ('A', $1, 'fa'), ('B', $2, 'fb')`,
      [PROJECT.a, PROJECT.b],
    );
    // Обход настоящий: через предка область A видит строку B.
    expect(
      await withScope(database.appDb, scope, PROJECT.a, async (_tx, client) =>
        (await client.query<{ title: string }>('SELECT title FROM entity ORDER BY title')).rows.map(
          (row) => row.title,
        ),
      ),
    ).toEqual(['A', 'B']);
    expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.inheritanceAncestor, 'entity']]);
    await database.app.query('REVOKE ALL ON entity FROM CURRENT_USER');
    expect(await problemsOf(database.app, scope)).toBe('ready');
  });

  it('права на колонки — тоже доступ: материализованное представление и таблица вне списка с GRANT SELECT (колонка)', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    await database.admin.query(`
      CREATE MATERIALIZED VIEW col_mv AS SELECT project_id, body FROM items;
      CREATE TABLE col_leak (project_id uuid, body text);
      CREATE MATERIALIZED VIEW hidden_mv AS SELECT project_id, body FROM items;
    `);
    try {
      expect(await problemsOf(database.app, scope)).toBe('ready');
      await database.admin.query(`
        GRANT SELECT (body) ON col_mv TO ${database.roles.app};
        GRANT INSERT (project_id) ON col_leak TO ${database.roles.app};
      `);
      expect(await problemsOf(database.app, scope)).toEqual([
        [SCOPE_PROBLEM.materializedView, 'col_mv'],
        [SCOPE_PROBLEM.unlistedTable, 'col_leak'],
      ]);
    } finally {
      await database.admin.query('DROP MATERIALIZED VIEW col_mv, hidden_mv; DROP TABLE col_leak');
    }
  });

  it('роль без INHERIT: права роли, в которую она входит (SET ROLE), — её права; членство без прав — готово', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    const viewer = await database.extraRole('noinherit', 'NOINHERIT');
    const empty = await database.extraRole('emptyrole');
    const rich = await database.extraRole('richrole');
    await database.admin.query(`GRANT SELECT ON items, notes TO ${viewer.role}`);
    await database.admin.query(`GRANT ${empty.role}, ${rich.role} TO ${viewer.role}`);
    expect(await problemsOf(viewer.pool, scope)).toBe('ready');
    await database.app.query(`GRANT TRUNCATE ON items TO ${rich.role}`);
    expect(await problemsOf(viewer.pool, scope)).toEqual([[SCOPE_PROBLEM.truncatePrivilege, 'items']]);
  });

  it('REPLICATION у роли или у роли, в которую она входит, — escalation; NOREPLICATION — готово', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    const plain = await database.extraRole('norepl', 'NOREPLICATION');
    await database.admin.query(`GRANT SELECT ON items, notes TO ${plain.role}`);
    expect(await problemsOf(plain.pool, scope)).toBe('ready');
    const replicator = await database.extraRole('repl', 'REPLICATION');
    const member = await database.extraRole('replmember');
    await database.admin.query(`GRANT ${replicator.role} TO ${member.role}`);
    expect(await problemsOf(replicator.pool, scope)).toEqual([[SCOPE_PROBLEM.escalation, null]]);
    expect(await problemsOf(member.pool, scope)).toEqual([[SCOPE_PROBLEM.escalation, null]]);
  });

  it('EXECUTE на функцию чтения файлов сервера — escalation (файл таблицы читается по относительному пути); на постороннюю функцию — готово', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    const reader = await database.extraRole('filereader');
    await database.admin.query(`GRANT SELECT ON items, notes TO ${reader.role}`);
    await database.admin.query(`GRANT EXECUTE ON FUNCTION pg_ls_waldir() TO ${reader.role}`);
    expect(await problemsOf(reader.pool, scope)).toBe('ready');
    await database.admin.query(`GRANT EXECUTE ON FUNCTION pg_read_binary_file(text) TO ${reader.role}`);
    await database.admin.query('CHECKPOINT');
    const { rows } = await database.admin.query<{ path: string }>(
      "SELECT pg_relation_filepath('items') AS path",
    );
    const found = await withScope(
      drizzle(reader.pool),
      scope,
      PROJECT.a,
      async (_tx, client) =>
        (
          await client.query<{ found: boolean }>(
            "SELECT position('b.1'::bytea IN pg_read_binary_file($1)) > 0 AS found",
            [rows[0]?.path],
          )
        ).rows[0]?.found,
    );
    expect(found).toBe(true);
    expect(await problemsOf(reader.pool, scope)).toEqual([[SCOPE_PROBLEM.escalation, null]]);
  });

  it('каскад из общей таблицы, которую роль может менять, — foreign-key-across-scopes; общая только для чтения или без каскада — готово', async () => {
    const scope = scopeOf(['docs']);
    await database.admin.query(`
      CREATE TABLE shared_users (id int PRIMARY KEY);
      GRANT SELECT, REFERENCES ON shared_users TO ${database.roles.app};
      INSERT INTO shared_users VALUES (1), (2);
    `);
    try {
      await database.app.query(`
        CREATE TABLE users (id int PRIMARY KEY);
        CREATE TABLE docs (id serial PRIMARY KEY, project_id uuid NOT NULL, body text NOT NULL,
          author_id int REFERENCES users (id) ON DELETE CASCADE,
          reviewer_id int REFERENCES shared_users (id) ON DELETE CASCADE,
          editor_id int REFERENCES users (id) ON DELETE RESTRICT);
        ${scopePolicySql(scope)}
        INSERT INTO users VALUES (1);
      `);
      await database.admin.query(
        `INSERT INTO docs (project_id, body, author_id) VALUES ($1, 'doc A', 1), ($2, 'doc B', 1)`,
        [PROJECT.a, PROJECT.b],
      );
      // Обход настоящий: удаление общей строки из работы области A удаляет документ B.
      await withScope(database.appDb, scope, PROJECT.a, (_tx, client) =>
        client.query('DELETE FROM users WHERE id = 1'),
      );
      expect(await bodiesOf(database.admin, 'docs')).toEqual([]);
      expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.foreignKeyAcrossScopes, 'docs']]);
      await database.app.query('ALTER TABLE docs DROP CONSTRAINT docs_author_id_fkey');
      expect(await problemsOf(database.app, scope)).toBe('ready');
    } finally {
      await database.admin.query('DROP TABLE IF EXISTS docs; DROP TABLE shared_users');
    }
  });

  it('представление без security_invoker: владелец — роль сессии — готово (изоляция держится); владелец — другая роль — отказ', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    await database.app.query('CREATE VIEW own_v AS SELECT project_id, body FROM items');
    expect(
      await withScope(database.appDb, scope, PROJECT.b, async (_tx, client) =>
        (await client.query<{ body: string }>('SELECT body FROM own_v')).rows.map((row) => row.body),
      ),
    ).toEqual(['b.1']);
    expect(await problemsOf(database.app, scope)).toBe('ready');
    await database.admin.query(
      `CREATE VIEW admin_v AS SELECT project_id, body FROM items; GRANT SELECT ON admin_v TO ${database.roles.app}`,
    );
    try {
      expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.viewNotInvoker, 'admin_v']]);
    } finally {
      await database.admin.query('DROP VIEW admin_v');
    }
  });

  it('колонка varchar(n) и имена в смешанном регистре (Prisma) — готово и изоляция работает; text при varchar в описании — column-mismatch', async () => {
    const varchar = scopeOf(['tv'], SCOPE_COLUMN_TYPE.varchar);
    await database.app.query(
      `CREATE TABLE tv (id serial, project_id varchar(64) NOT NULL, body text NOT NULL); ${scopePolicySql(varchar)}`,
    );
    await database.admin.query(
      "INSERT INTO tv (project_id, body) VALUES ('acme', 'acme'), ('other', 'other')",
    );
    expect(await problemsOf(database.app, varchar)).toBe('ready');
    expect(
      await withScope(database.appDb, varchar, 'acme', async (_tx, client) =>
        (await client.query<{ body: string }>('SELECT body FROM tv')).rows.map((row) => row.body),
      ),
    ).toEqual(['acme']);
    expect(await problemsOf(database.app, scopeOf(['tv'], SCOPE_COLUMN_TYPE.text))).toEqual([
      [SCOPE_PROBLEM.columnMismatch, 'tv'],
      [SCOPE_PROBLEM.policyMismatch, 'tv'],
    ]);
    await database.app.query('DROP TABLE tv');
    const prisma = scopeOf(['Document'], SCOPE_COLUMN_TYPE.uuid, 'projectId');
    await database.app.query(
      `CREATE TABLE "Document" (id serial, "projectId" uuid NOT NULL, body text NOT NULL); ${scopePolicySql(prisma)}`,
    );
    await database.admin.query(`INSERT INTO "Document" ("projectId", body) VALUES ($1, 'a'), ($2, 'b')`, [
      PROJECT.a,
      PROJECT.b,
    ]);
    expect(await problemsOf(database.app, prisma)).toBe('ready');
    expect(
      await withScope(database.appDb, prisma, PROJECT.b, async (_tx, client) =>
        (await client.query<{ body: string }>('SELECT body FROM "Document"')).rows.map((row) => row.body),
      ),
    ).toEqual(['b']);
  });

  it('политика сквозного доступа выдана не только роли сквозного доступа — policy-mismatch', async () => {
    const scope = scopeOf();
    await createScopeTables(
      database,
      scope,
      scopePolicySql(scope).replaceAll(
        `TO "${database.roles.maintenance}"`,
        `TO "${database.roles.maintenance}", "${database.roles.reader}"`,
      ),
    );
    expect(await problemsOf(database.app, scope)).toEqual([
      [SCOPE_PROBLEM.policyMismatch, 'items'],
      [SCOPE_PROBLEM.policyMismatch, 'notes'],
    ]);
  });

  it('canonicalFrom — тот же пул из одного соединения: готово, а не ожидание самого себя; timeoutMs больше 2^31−1 — отказ', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    const single = database.pool('app', 1);
    expect(await problemsOf(single, scope, { canonicalFrom: single, timeoutMs: 5_000 })).toBe('ready');
    await expect(assertScopeReady(single, scope, { timeoutMs: 2 ** 31 })).rejects.toThrow('timeoutMs');
    await expect(assertScopeReady(single, scope, { timeoutMs: 2 ** 31 - 1 })).resolves.toBeUndefined();
  });

  it('CREATEROLE: ниже Postgres 16 роль выдаёт себе роль сквозного доступа — escalation; с 16 — не может, готово', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    const creator = await database.extraRole('creator', 'NOSUPERUSER CREATEROLE');
    await database.admin.query(`GRANT SELECT ON items, notes TO ${creator.role}`);
    const { rows } = await database.admin.query<{ version: number }>(
      "SELECT current_setting('server_version_num')::int AS version",
    );
    const below16 = (rows[0]?.version ?? 0) < 160_000;
    const problems = await problemsOf(creator.pool, scope);
    const granted = await creator.pool.query(`GRANT ${database.roles.maintenance} TO ${creator.role}`).then(
      () => 'выдано',
      (error: unknown) => (error as { code?: string }).code,
    );
    await database.admin.query(`REVOKE ${database.roles.maintenance} FROM ${creator.role}`);
    expect({ below16, problems, granted }).toEqual(
      below16
        ? { below16, problems: [[SCOPE_PROBLEM.escalation, null]], granted: 'выдано' }
        : { below16, problems: 'ready', granted: '42501' },
    );
  });

  it('внешняя таблица (postgres_fdw) с колонкой области: RLS не поддерживает — в списке «не таблица», вне списка — unlisted-table; без прав — готово', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    await database.admin.query(`
      CREATE EXTENSION IF NOT EXISTS postgres_fdw;
      CREATE SERVER scope_remote FOREIGN DATA WRAPPER postgres_fdw OPTIONS (dbname 'postgres');
      CREATE FOREIGN TABLE remote_items (project_id uuid, body text) SERVER scope_remote;
    `);
    try {
      const enable = await database.admin.query('ALTER TABLE remote_items ENABLE ROW LEVEL SECURITY').then(
        () => 'включено',
        (error: unknown) => (error as { code?: string }).code,
      );
      expect(enable).toBe('42809');
      expect(await problemsOf(database.app, scope)).toBe('ready');
      await database.admin.query(`GRANT SELECT ON remote_items TO ${database.roles.app}`);
      expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.unlistedTable, 'remote_items']]);
      expect(await problemsOf(database.app, scopeOf(['items', 'notes', 'remote_items']))).toEqual([
        [SCOPE_PROBLEM.tableMissing, 'remote_items'],
      ]);
    } finally {
      await database.admin.query('DROP SERVER scope_remote CASCADE; DROP EXTENSION postgres_fdw');
    }
  });

  it('замёрзшая сеть посреди проверки: потолок timeoutMs держит, соединение уничтожается; после разморозки — готово', async () => {
    const scope = scopeOf();
    await createScopeTables(database, scope);
    const target = new URL(database.urls.app);
    const proxy = await FaultProxy.start({ host: target.hostname, port: Number(target.port) });
    try {
      const via = new URL(database.urls.app);
      via.hostname = proxy.host;
      via.port = String(proxy.port);
      const pool = new Pool({ connectionString: via.toString(), max: 1 });
      try {
        await pool.query('SELECT 1');
        proxy.freeze();
        expect(await problemsOf(pool, scope, { timeoutMs: 300 })).toEqual([
          [SCOPE_PROBLEM.undetermined, null],
        ]);
        expect(pool.totalCount).toBe(0);
        proxy.thaw();
        expect(await problemsOf(pool, scope)).toBe('ready');
      } finally {
        proxy.thaw();
        await pool.end();
      }
    } finally {
      await proxy.close();
    }
  });
});
