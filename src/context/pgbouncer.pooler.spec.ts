import { PoolerIncompatibleError, SessionStateLeakError } from '@hoshinotatsuya/pg-runtime';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';

import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { scopePolicySql } from '../policy/scope-policy-sql';
import { defineProjectScope } from '../scope/define-project-scope';
import { createScopeTables } from '../testing/create-scope-tables';
import { problemsOf } from '../testing/problems-of';
import { PROJECT } from '../testing/project.constant';
import { rejectionOf } from '../testing/rejection-of';
import { createScopeTestDatabase } from '../testing/scope-test-database';
import type { ScopeTestDatabase } from '../testing/scope-test-database.type';
import { sessionSetByExecute } from '../testing/session-set-by-execute';
import type { ProjectScope } from '../types/project-scope.type';
import { withCrossScope } from './with-cross-scope';
import { withScope } from './with-scope';

const POOLER_URL = process.env.PG_POOLER_URL;
const describePooler = POOLER_URL ? describe : describe.skip;

const OPTIONS = { transactionPooler: true } as const;

/**
 * Настоящий PgBouncer в transaction mode, одно серверное соединение на базу и
 * роль: все клиенты по очереди делят ОДНО соединение сервера (`pg_backend_pid`
 * одинаков), и сессионное состояние одного достаётся следующему.
 */
describePooler(
  'withScope и assertScopeReady через PgBouncer в transaction mode [нужен PG_POOLER_URL]',
  () => {
    let database: ScopeTestDatabase;
    let scope: ProjectScope;
    const pools: Pool[] = [];

    const pooled = (role: 'app' | 'maintenance' = 'app'): Pool => {
      const target = new URL(POOLER_URL as string);
      const app = new URL(database.urls[role]);
      target.pathname = app.pathname;
      target.username = app.username;
      target.password = app.password;
      const pool = new Pool({ connectionString: target.toString(), max: 2 });
      pools.push(pool);
      return pool;
    };
    const read = async (client: Pick<PoolClient, 'query'>): Promise<{ pid: number; rows: string[] }> => {
      const { rows } = await client.query<{ pid: number; body: string | null }>(
        "SELECT pg_backend_pid() AS pid, (SELECT string_agg(body, ',' ORDER BY body) FROM items) AS body",
      );
      return {
        pid: rows[0]?.pid ?? -1,
        rows: (rows[0]?.body ?? '').split(',').filter((body) => body !== ''),
      };
    };

    beforeAll(async () => {
      database = await createScopeTestDatabase();
      scope = defineProjectScope({
        setting: 'app.project_id',
        column: 'project_id',
        columnType: SCOPE_COLUMN_TYPE.uuid,
        tables: ['items', 'notes'],
        maintenanceRole: database.roles.maintenance,
      });
      await createScopeTables(database, scope, scopePolicySql(scope));
    });
    afterAll(async () => {
      await Promise.all(pools.map((pool) => pool.end().catch(() => undefined)));
      await database?.drop();
    });

    it('соседи по одному серверному соединению: каждая область видит только своё, запрос без контекста — ничего', async () => {
      const first = drizzle(pooled());
      const second = pooled();
      const seen = [
        await withScope(first, scope, PROJECT.a, (_tx, client) => read(client), OPTIONS),
        await read(second),
        await withScope(drizzle(second), scope, PROJECT.b, (_tx, client) => read(client), OPTIONS),
        await read(second),
      ];
      expect(new Set(seen.map((entry) => entry.pid)).size).toBe(1);
      expect(seen.map((entry) => entry.rows)).toEqual([['a.1', 'a.2'], [], ['b.1'], []]);
    });

    it('set_config(…, false) в работе: параметром и литералом — отказ pg-runtime до отправки; в обход фильтра (EXECUTE в DO) — сосед по серверному соединению контекста не видит', async () => {
      const worker = drizzle(pooled());
      const neighbour = pooled();
      for (const [text, values] of [
        ['SELECT set_config($1, $2, $3)', ['app.project_id', PROJECT.a, false]],
        ["SELECT set_config('app.project_id', $1, false)", [PROJECT.b]],
      ] as const) {
        const refused = await rejectionOf(
          withScope(worker, scope, PROJECT.a, (_tx, client) => client.query(text, [...values]), OPTIONS),
        );
        expect(refused).toBeInstanceOf(PoolerIncompatibleError);
      }
      const inWork = await withScope(
        worker,
        scope,
        PROJECT.a,
        async (_tx, client) => {
          await client.query(sessionSetByExecute('app.project_id', PROJECT.a));
          const { rows } = await client.query<{ value: string }>(
            "SELECT current_setting('app.project_id') AS value",
          );
          return rows[0]?.value;
        },
        OPTIONS,
      );
      expect(inWork).toBe(PROJECT.a);
      expect((await read(neighbour)).rows).toEqual([]);
    });

    it('сессионная причина из работы сквозного доступа (set_config в обход фильтра) не достаётся соседу по серверному соединению', async () => {
      const reason = 'ночная очистка устаревших строк всех проектов';
      const worker = drizzle(pooled('maintenance'));
      const neighbour = pooled('maintenance');
      // Сессионное значение, равное причине: сверка к концу работы его не отличает — снимает только сброс.
      await withCrossScope(
        worker,
        scope,
        { reason },
        (_tx, client) => client.query(sessionSetByExecute(scope.reasonSetting, reason)),
        OPTIONS,
      );
      const { rows } = await neighbour.query<{ pid: number; reason: string | null }>(
        'SELECT pg_backend_pid() AS pid, current_setting($1, true) AS reason',
        [scope.reasonSetting],
      );
      expect(rows[0]?.reason ?? '').toBe('');
    });

    it('assertScopeReady через пулер — готово', async () => {
      expect(await problemsOf(pooled(), scope)).toBe('ready');
    });

    it('временная таблица: ON COMMIT DROP не доживает до соседа; без него — отказ pg-runtime: текстом до отправки, в обход фильтра — сверкой состояния', async () => {
      const worker = drizzle(pooled());
      const neighbour = pooled();
      const visible = async (): Promise<string | null> =>
        (
          await neighbour.query<{ table: string | null }>(
            "SELECT to_regclass('pg_temp.staging')::text AS table",
          )
        ).rows[0]?.table ?? null;
      await withScope(
        worker,
        scope,
        PROJECT.a,
        async (_tx, client) => {
          await client.query('CREATE TEMP TABLE staging (body text) ON COMMIT DROP');
          await client.query('INSERT INTO staging SELECT body FROM items');
        },
        OPTIONS,
      );
      expect(await visible()).toBeNull();
      const text = await rejectionOf(
        withScope(
          worker,
          scope,
          PROJECT.a,
          (_tx, client) => client.query('CREATE TEMP TABLE staging AS SELECT body FROM items'),
          OPTIONS,
        ),
      );
      expect(text).toBeInstanceOf(PoolerIncompatibleError);
      expect(await visible()).toBeNull();
      const executed = await rejectionOf(
        withScope(
          worker,
          scope,
          PROJECT.a,
          (_tx, client) => client.query("DO $$BEGIN EXECUTE 'CREATE TEMP TABLE staging (body text)'; END$$"),
          OPTIONS,
        ),
      );
      // Сверка после транзакции: временная таблица — утечка; работа зафиксирована, таблицу видит сосед.
      expect(executed).toBeInstanceOf(SessionStateLeakError);
      expect((executed as SessionStateLeakError).committed).toBe(true);
      expect(await visible()).not.toBeNull();
      await neighbour.query('DROP TABLE pg_temp.staging');
    });
  },
);
