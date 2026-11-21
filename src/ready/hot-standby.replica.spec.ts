import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { SCOPE_PROBLEM } from '../constants/scope-problem.constant';
import { withScope } from '../context/with-scope';
import { defineProjectScope } from '../scope/define-project-scope';
import { createScopeTables } from '../testing/create-scope-tables';
import { problemsOf } from '../testing/problems-of';
import { PROJECT } from '../testing/project.constant';
import { rejectionOf } from '../testing/rejection-of';
import { createScopeTestDatabase } from '../testing/scope-test-database';
import type { ScopeTestDatabase } from '../testing/scope-test-database.type';
import type { ProjectScope } from '../types/project-scope.type';

const REPLICA_URL = process.env.PG_REPLICA_URL;
const describeReplica = REPLICA_URL ? describe : describe.skip;

/**
 * Горячая реплика в восстановлении не пишет вовсе: эталон политик там не
 * построить, и проверка — отказ `undetermined`, а не «готово». С эталоном с
 * основного (`canonicalFrom`) реплика проверяется целиком. Работа области на
 * реплике читает только свою область.
 */
describeReplica('assertScopeReady и withScope на горячей реплике [нужен PG_REPLICA_URL]', () => {
  let database: ScopeTestDatabase;
  let scope: ProjectScope;
  let replicaApp: Pool;

  beforeAll(async () => {
    database = await createScopeTestDatabase();
    scope = defineProjectScope({
      setting: 'app.project_id',
      column: 'project_id',
      columnType: SCOPE_COLUMN_TYPE.uuid,
      tables: ['items', 'notes'],
      maintenanceRole: database.roles.maintenance,
    });
    await createScopeTables(database, scope);
    const url = (base: string): string => {
      const target = new URL(base);
      const app = new URL(database.urls.app);
      target.pathname = app.pathname;
      target.username = app.username;
      target.password = app.password;
      return target.toString();
    };
    replicaApp = new Pool({ connectionString: url(REPLICA_URL as string), max: 2 });
    // Реплика догоняет основной: ждём строки таблиц области.
    const replicaAdmin = new URL(REPLICA_URL as string);
    replicaAdmin.pathname = new URL(database.urls.app).pathname;
    const watcher = new Pool({ connectionString: replicaAdmin.toString(), max: 1 });
    try {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const seen = await watcher
          .query<{ n: number }>('SELECT count(*)::int AS n FROM items')
          .then((result) => result.rows[0]?.n ?? 0)
          .catch(() => 0);
        if (seen === 3) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const { rows } = await watcher.query<{ recovery: boolean }>('SELECT pg_is_in_recovery() AS recovery');
      expect(rows[0]?.recovery).toBe(true);
    } finally {
      await watcher.end();
    }
  });
  afterAll(async () => {
    await replicaApp?.end();
    await database?.drop();
  });

  it('эталон на реплике не построить — undetermined; с canonicalFrom основного — готово', async () => {
    expect(await problemsOf(replicaApp, scope)).toEqual([[SCOPE_PROBLEM.undetermined, null]]);
    expect(await problemsOf(replicaApp, scope, { canonicalFrom: database.app })).toBe('ready');
  });

  it('withScope на реплике читает только свою область, запись — отказ сервера', async () => {
    const db = drizzle(replicaApp);
    const rows = await withScope(db, scope, PROJECT.a, async (_tx, client) =>
      (await client.query<{ body: string }>('SELECT body FROM items ORDER BY body')).rows.map(
        (row) => row.body,
      ),
    );
    expect(rows).toEqual(['a.1', 'a.2']);
    const write = await rejectionOf(
      withScope(db, scope, PROJECT.a, (_tx, client) =>
        client.query("INSERT INTO items (project_id, body) VALUES ($1, 'x')", [PROJECT.a]),
      ),
    );
    expect((write as { code?: string }).code).toBe('25006');
  });
});
