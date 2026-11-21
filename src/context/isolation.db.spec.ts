import {
  CommitRolledBackError,
  SESSION_BASELINE,
  TransactionClientMisuseError,
  transactionKeepingFailure,
} from '@hoshinotatsuya/pg-runtime';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';

import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { ScopeConflictError } from '../errors/scope-conflict.error';
import { scopePolicySql } from '../policy/scope-policy-sql';
import { defineProjectScope } from '../scope/define-project-scope';
import { bodiesOf } from '../testing/bodies-of';
import { createScopeTables } from '../testing/create-scope-tables';
import { describeDb } from '../testing/describe-db';
import { PROJECT } from '../testing/project.constant';
import { rejectionOf } from '../testing/rejection-of';
import { createScopeTestDatabase } from '../testing/scope-test-database';
import type { ScopeTestDatabase } from '../testing/scope-test-database.type';
import { sessionSetByExecute } from '../testing/session-set-by-execute';
import type { ProjectScope } from '../types/project-scope.type';
import { withCrossScope } from './with-cross-scope';
import { withScope } from './with-scope';

const bodies = async (client: PoolClient, table = 'items'): Promise<string[]> => {
  const { rows } = await client.query<{ body: string }>(`SELECT body FROM ${table} ORDER BY body`);
  return rows.map((row) => row.body);
};

const pidOf = async (queryable: Pool | PoolClient): Promise<number> => {
  const { rows } = await queryable.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return rows[0]?.pid ?? -1;
};

/** Отказ — ошибка Postgres с этим SQLSTATE (42501 — нарушение политики RLS). */
const sqlStateOf = (error: unknown): string | undefined => (error as { code?: string }).code;

/**
 * Всё — под РОЛЬЮ ПРИЛОЖЕНИЯ, которая ещё и ВЛАДЕЛЕЦ таблиц: без FORCE она
 * политик не проходила бы, и снятие FORCE обязано краснеть здесь.
 */
describeDb('изоляция области под ролью приложения [нужен PG_TEST_URL]', () => {
  let database: ScopeTestDatabase;
  let scope: ProjectScope;

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
  });
  afterAll(async () => {
    await database?.drop();
  });

  const visible = (scopeId: string, table = 'items', db = database.appDb) =>
    withScope(db, scope, scopeId, async (_tx, client) => bodies(client, table));

  it('фикстура: роль приложения владеет таблицами, а суперпользователь видит все строки', async () => {
    const { rows } = await database.admin.query<{ owner: string }>(
      "SELECT tableowner AS owner FROM pg_tables WHERE tablename IN ('items', 'notes') ORDER BY tablename",
    );
    expect(rows).toEqual([{ owner: database.roles.app }, { owner: database.roles.app }]);
    expect(await bodiesOf(database.admin, 'items')).toEqual(['a.1', 'a.2', 'b.1']);
  });

  it('забытый WHERE: каждая область видит ровно свои строки в каждой таблице', async () => {
    expect(await visible(PROJECT.a)).toEqual(['a.1', 'a.2']);
    expect(await visible(PROJECT.b)).toEqual(['b.1']);
    expect(await visible(PROJECT.empty)).toEqual([]);
    expect(await visible(PROJECT.a, 'notes')).toEqual(['a.note']);
    expect(await visible(PROJECT.b, 'notes')).toEqual(['b.note']);
    // Явный фильтр на чужую область внутри своей — тоже ничего.
    const foreign = await withScope(database.appDb, scope, PROJECT.a, async (_tx, client) => {
      const { rows } = await client.query('SELECT body FROM items WHERE project_id = $1', [PROJECT.b]);
      return rows;
    });
    expect(foreign).toEqual([]);
  });

  it('запрос drizzle в транзакции области — тот же отбор', async () => {
    const rows = await withScope(database.appDb, scope, PROJECT.b, async (tx) => {
      const result = await tx.execute<{ body: string }>(sql`SELECT body FROM items ORDER BY body`);
      return result.rows.map((row) => row.body);
    });
    expect(rows).toEqual(['b.1']);
  });

  it('INSERT строки чужой области — отказ политики (42501), строка не появилась', async () => {
    const error = await rejectionOf(
      withScope(database.appDb, scope, PROJECT.a, (_tx, client) =>
        client.query("INSERT INTO items (project_id, body) VALUES ($1, 'stolen')", [PROJECT.b]),
      ),
    );
    expect(sqlStateOf(error)).toBe('42501');
    expect(await bodiesOf(database.admin, 'items')).toEqual(['a.1', 'a.2', 'b.1']);
  });

  it('UPDATE: чужие строки не задеты, перенос своей строки в чужую область — отказ WITH CHECK', async () => {
    const touched = await withScope(database.appDb, scope, PROJECT.a, async (_tx, client) => {
      const result = await client.query("UPDATE items SET body = body || '!' WHERE project_id = $1", [
        PROJECT.b,
      ]);
      return result.rowCount;
    });
    expect(touched).toBe(0);
    const error = await rejectionOf(
      withScope(database.appDb, scope, PROJECT.a, (_tx, client) =>
        client.query("UPDATE items SET project_id = $1 WHERE body = 'a.1'", [PROJECT.b]),
      ),
    );
    expect(sqlStateOf(error)).toBe('42501');
    expect(await bodiesOf(database.admin, 'items')).toEqual(['a.1', 'a.2', 'b.1']);
  });

  it('DELETE без WHERE удаляет только строки своей области', async () => {
    const rollback = new Error('откат проверки');
    let deleted: number | null = -1;
    const outcome = await rejectionOf(
      withScope(database.appDb, scope, PROJECT.a, async (_tx, client) => {
        deleted = (await client.query('DELETE FROM items')).rowCount;
        throw rollback;
      }),
    );
    expect(outcome).toBe(rollback);
    expect(deleted).toBe(2);
    expect(await bodiesOf(database.admin, 'items')).toEqual(['a.1', 'a.2', 'b.1']);
  });

  it('без контекста — ноль строк и отказ записи, в транзакции и вне её', async () => {
    expect(await bodiesOf(database.app, 'items')).toEqual([]);
    expect(await bodiesOf(database.app, 'notes')).toEqual([]);
    const inTransaction = await transactionKeepingFailure(database.appDb, async (_tx, client) =>
      bodies(client),
    );
    expect(inTransaction).toEqual([]);
    const error = await rejectionOf(
      database.app.query("INSERT INTO items (project_id, body) VALUES ($1, 'orphan')", [PROJECT.a]),
    );
    expect(sqlStateOf(error)).toBe('42501');
    expect(await bodiesOf(database.admin, 'items')).toEqual(['a.1', 'a.2', 'b.1']);
  });

  it('контекст не достаётся следующему владельцу соединения пула (SET LOCAL)', async () => {
    const single = database.pool('app', 1);
    const db = drizzle(single);
    const inside = await withScope(db, scope, PROJECT.a, async (_tx, client) => ({
      pid: await pidOf(client),
      rows: await bodies(client),
    }));
    const { rows } = await single.query<{ context: string | null }>(
      "SELECT current_setting('app.project_id', true) AS context",
    );
    // То же соединение: иначе проверка не о соседе по соединению.
    expect(await pidOf(single)).toBe(inside.pid);
    expect(inside.rows).toEqual(['a.1', 'a.2']);
    expect(rows[0]?.context ?? '').toBe('');
    expect(await bodiesOf(single, 'items')).toEqual([]);
  });

  it('пулер-сценарий: одно соединение по очереди разным областям — каждая видит только своё', async () => {
    const single = database.pool('app', 1);
    const db = drizzle(single);
    const order = [PROJECT.a, PROJECT.b, PROJECT.a, PROJECT.empty, PROJECT.b];
    const seen: { pid: number; rows: string[] }[] = [];
    for (const project of order) {
      seen.push(
        await withScope(db, scope, project, async (_tx, client) => ({
          pid: await pidOf(client),
          rows: await bodies(client),
        })),
      );
      // Между транзакциями — запрос без контекста на том же соединении.
      seen.push({ pid: await pidOf(single), rows: await bodiesOf(single, 'items') });
    }
    expect(new Set(seen.map((entry) => entry.pid)).size).toBe(1);
    expect(seen.map((entry) => entry.rows)).toEqual([
      ['a.1', 'a.2'],
      [],
      ['b.1'],
      [],
      ['a.1', 'a.2'],
      [],
      [],
      [],
      ['b.1'],
      [],
    ]);
  });

  it('параллельные транзакции разных областей одновременно: каждая видит только своё (множествами)', async () => {
    const parallel = database.pool('app', 10);
    const db = drizzle(parallel);
    try {
      await Promise.all(
        Array.from({ length: 10 }, (_, index) => {
          const project = index % 2 === 0 ? PROJECT.a : PROJECT.b;
          return withScope(db, scope, project, (_tx, client) =>
            client.query('INSERT INTO items (project_id, body) VALUES ($1, $2)', [
              project,
              `p-${project === PROJECT.a ? 'a' : 'b'}-${index}`,
            ]),
          );
        }),
      );
      // Барьер: все десять транзакций открыты одновременно, прежде чем читать.
      let arrived = 0;
      let release: () => void = () => undefined;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) => {
          const project = index % 2 === 0 ? PROJECT.a : PROJECT.b;
          return withScope(db, scope, project, async (_tx, client) => {
            arrived += 1;
            if (arrived === 10) {
              release();
            }
            await barrier;
            return { project, pid: await pidOf(client), rows: new Set(await bodies(client)) };
          });
        }),
      );
      const expected = {
        [PROJECT.a]: new Set(['a.1', 'a.2', 'p-a-0', 'p-a-2', 'p-a-4', 'p-a-6', 'p-a-8']),
        [PROJECT.b]: new Set(['b.1', 'p-b-1', 'p-b-3', 'p-b-5', 'p-b-7', 'p-b-9']),
      };
      expect(new Set(results.map((result) => result.pid)).size).toBe(10);
      for (const result of results) {
        expect(result.rows).toEqual(expected[result.project]);
      }
    } finally {
      await database.admin.query("DELETE FROM items WHERE body LIKE 'p-%'");
    }
  });

  it('вложенный withScope: та же область — точка сохранения, другая — ScopeConflictError', async () => {
    const same = await withScope(database.appDb, scope, PROJECT.a, () =>
      withScope(database.appDb, scope, PROJECT.a, async (_tx, client) => bodies(client)),
    );
    expect(same).toEqual(['a.1', 'a.2']);
    const conflict = await rejectionOf(
      withScope(database.appDb, scope, PROJECT.a, () =>
        withScope(database.appDb, scope, PROJECT.b, async (_tx, client) => bodies(client)),
      ),
    );
    expect(conflict).toBeInstanceOf(ScopeConflictError);
    // Значения областей в текст отказа не попадают: он уходит в логи.
    expect(String(conflict)).not.toContain(PROJECT.b);
    expect(String(conflict)).not.toContain(PROJECT.a);
    // Другая область на другом пуле — тоже отказ: одна цепочка вызовов — одна область.
    const otherPool = drizzle(database.pool('app', 1));
    const crossPool = await rejectionOf(
      withScope(database.appDb, scope, PROJECT.a, () => visible(PROJECT.b, 'items', otherPool)),
    );
    expect(crossPool).toBeInstanceOf(ScopeConflictError);
  });

  it('другая область на ТОМ ЖЕ пуле внутри работы области — ScopeConflictError: две области в одной транзакции', async () => {
    const tenant = defineProjectScope({
      setting: 'app.tenant_id',
      column: 'project_id',
      columnType: SCOPE_COLUMN_TYPE.uuid,
      tables: ['items'],
    });
    const error = await rejectionOf(
      withScope(database.appDb, scope, PROJECT.a, () =>
        withScope(database.appDb, tenant, PROJECT.a, async (_tx, client) => bodies(client)),
      ),
    );
    expect(error).toBeInstanceOf(ScopeConflictError);
    // Отказ ДО точки сохранения, а не позже — сверкой контекста чужого параметра.
    expect(String(error)).toContain('на том же пуле: две области в одной транзакции');
  });

  it('продолжение, запланированное из работы, после её конца областью не связано', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let later: Promise<string[]> = Promise.resolve([]);
    await withScope(database.appDb, scope, PROJECT.a, async () => {
      later = gate.then(() => visible(PROJECT.b));
    });
    release();
    expect(await later).toEqual(['b.1']);
  });

  it('вложенный withScope той же области на ДРУГОМ пуле — своя транзакция на своём соединении, с контекстом', async () => {
    const otherPool = drizzle(database.pool('app', 1));
    const seen = await withScope(database.appDb, scope, PROJECT.a, async (_tx, client) => {
      const outerPid = await pidOf(client);
      const inner = await withScope(otherPool, scope, PROJECT.a, async (_innerTx, innerClient) => ({
        pid: await pidOf(innerClient),
        rows: await bodies(innerClient),
      }));
      return { outerPid, inner };
    });
    expect(seen.inner.pid).not.toBe(seen.outerPid);
    expect(seen.inner.rows).toEqual(['a.1', 'a.2']);
  });

  it('роль сквозного доступа в withScope видит и пишет только свою область', async () => {
    const seen = await withScope(database.maintenanceDb, scope, PROJECT.a, async (_tx, client) => ({
      rows: await bodies(client),
      touched: (await client.query("UPDATE items SET body = body || '!' WHERE project_id = $1", [PROJECT.b]))
        .rowCount,
    }));
    expect(seen).toEqual({ rows: ['a.1', 'a.2'], touched: 0 });
    expect(await bodiesOf(database.admin, 'items')).toEqual(['a.1', 'a.2', 'b.1']);
  });

  it('сессионный set_config и SET в работе не достаются следующему владельцу соединения', async () => {
    const single = database.pool('app', 1);
    const db = drizzle(single);
    await withScope(db, scope, PROJECT.a, (_tx, client) =>
      client.query("SELECT set_config('app.project_id', $1, false)", [PROJECT.a]),
    );
    expect(await bodiesOf(single, 'items')).toEqual([]);
    await withScope(db, scope, PROJECT.b, (_tx, client) =>
      client.query(`SET app.project_id = '${PROJECT.b}'`),
    );
    expect(await bodiesOf(single, 'items')).toEqual([]);
  });

  it('работа, сменившая контекст, — ScopeConflictError: вложенная откатывается, внешняя остаётся в своей области', async () => {
    const outcome = await withScope(database.appDb, scope, PROJECT.a, async (_tx, client) => {
      const nested = await rejectionOf(
        withScope(database.appDb, scope, PROJECT.a, (_inner, innerClient) =>
          innerClient.query("SELECT set_config('app.project_id', $1, true)", [PROJECT.b]),
        ),
      );
      return { nested, rows: await bodies(client) };
    });
    expect(outcome.nested).toBeInstanceOf(ScopeConflictError);
    expect(outcome.rows).toEqual(['a.1', 'a.2']);
    const own = await rejectionOf(
      withScope(database.appDb, scope, PROJECT.a, async (_tx, client) => {
        await client.query("INSERT INTO items (project_id, body) VALUES ($1, 'switched')", [PROJECT.a]);
        await client.query("SELECT set_config('app.project_id', $1, true)", [PROJECT.b]);
      }),
    );
    expect(own).toBeInstanceOf(ScopeConflictError);
    expect(await bodiesOf(database.admin, 'items')).toEqual(['a.1', 'a.2', 'b.1']);
  });

  it('причина сквозного доступа, заданная в работе области, — ScopeConflictError, запись работы откатывается', async () => {
    const forged = await rejectionOf(
      withScope(database.appDb, scope, PROJECT.a, async (_tx, client) => {
        await client.query("INSERT INTO items (project_id, body) VALUES ($1, 'forged')", [PROJECT.a]);
        await client.query("SELECT set_config($1, 'ночная очистка (подделка)', true)", [scope.reasonSetting]);
      }),
    );
    expect(forged).toBeInstanceOf(ScopeConflictError);
    expect(await bodiesOf(database.admin, 'items')).toEqual(['a.1', 'a.2', 'b.1']);
  });

  it('работа, поймавшая ошибку запроса, — откат транзакции (CommitRolledBackError), а не ошибка проверки контекста', async () => {
    const outcome = await rejectionOf(
      withScope(database.appDb, scope, PROJECT.a, async (_tx, client) => {
        await client.query('SELECT 1 / 0').catch(() => undefined);
        return 'вернула успех';
      }),
    );
    expect(outcome).toBeInstanceOf(CommitRolledBackError);
  });

  it('вложенный withScope (точка сохранения): localSettings со сменой роли или параметром области — отказ ЭТОЙ функции, роль и область внешней работы те же', async () => {
    const outcomes: string[] = [];
    const after = await withScope(database.appDb, scope, PROJECT.a, async (_tx, client) => {
      for (const forbidden of [
        { role: database.roles.reader },
        { Session_Authorization: database.roles.reader },
        { 'app.project_id': PROJECT.b },
        { [scope.reasonSetting]: 'подделка причины' },
      ]) {
        const error = await rejectionOf(
          withScope(database.appDb, scope, PROJECT.a, async () => undefined, { localSettings: forbidden }),
        );
        outcomes.push(
          String(error).includes(`localSettings.${Object.keys(forbidden)[0]}`) ? 'отказ' : String(error),
        );
      }
      const { rows } = await client.query<{ role: string; context: string }>(
        "SELECT current_user::text AS role, current_setting('app.project_id', true) AS context",
      );
      return { ...rows[0], bodies: await bodies(client) };
    });
    expect({ outcomes, after }).toEqual({
      outcomes: ['отказ', 'отказ', 'отказ', 'отказ'],
      after: { role: database.roles.app, context: PROJECT.a, bodies: ['a.1', 'a.2'] },
    });
  });

  it('значение области проверяется до запроса; localSettings с параметром области — отказ', async () => {
    let queries = 0;
    const counting = database.pool('app', 1);
    counting.on('acquire', () => {
      queries += 1;
    });
    const db = drizzle(counting);
    for (const bad of ['', '   ', 'not-a-uuid', `${PROJECT.a}\0`]) {
      const error = await rejectionOf(withScope(db, scope, bad, async () => undefined));
      expect(String(error)).toContain('значение области app.project_id');
    }
    const reserved = await rejectionOf(
      withScope(db, scope, PROJECT.a, async () => undefined, {
        localSettings: { 'app.project_id': PROJECT.b },
      }),
    );
    expect(String(reserved)).toContain('localSettings.app.project_id');
    // Имена параметров Postgres регистр не различают; смена роли транзакции — тоже параметр.
    for (const forbidden of [
      { 'App.Project_Id': PROJECT.b },
      { [scope.reasonSetting.toUpperCase()]: 'подделка причины' },
      { role: database.roles.reader },
      { session_authorization: database.roles.reader },
    ]) {
      const error = await rejectionOf(
        withScope(db, scope, PROJECT.a, async () => undefined, { localSettings: forbidden }),
      );
      expect(String(error)).toContain(`localSettings.${Object.keys(forbidden)[0]}`);
    }
    expect(queries).toBe(0);
  });

  /**
   * Параметры соединения, которые видит работа: pid (то же соединение), то,
   * что задаёт обработчик connect, и свой параметр `app.*` (его Postgres не
   * показывает в `pg_settings`, и базовая линия pg-runtime его не восстанавливает).
   */
  const connectionSettings = async (pool: Pool): Promise<Record<string, string>> =>
    (
      await pool.query<Record<string, string>>(
        `SELECT pg_backend_pid()::text AS pid, current_setting('search_path') AS search_path,
                current_setting('TimeZone') AS time_zone, current_setting('application_name') AS application_name,
                current_setting('work_mem') AS work_mem, current_setting('statement_timeout') AS statement_timeout,
                coalesce(current_setting('app.flavor', true), '') AS flavor`,
      )
    ).rows[0] ?? {};

  /** Пул из одного соединения, обработчик connect которого задаёт параметры сессии SET. */
  const poolSettingOnConnect = (url: string): Pool => {
    const pool = new Pool({ connectionString: url, max: 1 });
    pool.on('connect', (client) => {
      client
        .query(
          `SET search_path TO scope_on_connect, public; SET TimeZone TO 'America/Sao_Paulo';
           SET application_name TO 'scope-on-connect'; SET work_mem TO '7MB'; SET app.flavor TO 'connect'`,
        )
        .catch(() => undefined);
    });
    return pool;
  };

  const ON_CONNECT = {
    search_path: 'scope_on_connect, public',
    time_zone: 'America/Sao_Paulo',
    application_name: 'scope-on-connect',
    work_mem: '7MB',
    flavor: 'connect',
  } as const;

  for (const [name, role, run] of [
    [
      'withScope',
      'app',
      (db: NodePgDatabase & { $client: Pool }) => withScope(db, scope, PROJECT.a, async () => undefined),
    ],
    [
      'withCrossScope',
      'maintenance',
      (db: NodePgDatabase & { $client: Pool }) =>
        withCrossScope(db, scope, { reason: 'проверка базовой линии' }, async () => undefined),
    ],
  ] as const) {
    it(`уборка соединения после ${name} возвращает его к состоянию после connect: SET из on(connect) остаётся (свой app.* — нет, предел pg-runtime назван в README)`, async () => {
      const pool = poolSettingOnConnect(database.urls[role]);
      try {
        const before = await connectionSettings(pool);
        expect(before).toMatchObject(ON_CONNECT);
        await run(drizzle(pool));
        // То же соединение (pid), параметры connect на месте; свой app.flavor стёрт уборкой.
        expect(await connectionSettings(pool)).toEqual({ ...before, flavor: '' });
        // Вторая работа на том же соединении: базовая линия — снимок первой выдачи, а не прошлой уборки.
        await run(drizzle(pool));
        expect(await connectionSettings(pool)).toEqual({ ...before, flavor: '' });
      } finally {
        await pool.end();
      }
    });
  }

  it('sessionBaseline: defaults проходит в pg-runtime как есть: уборка к значениям по умолчанию сессии', async () => {
    const pool = poolSettingOnConnect(database.urls.app);
    try {
      const before = await connectionSettings(pool);
      expect(before).toMatchObject(ON_CONNECT);
      await withScope(drizzle(pool), scope, PROJECT.a, async () => undefined, {
        sessionBaseline: SESSION_BASELINE.defaults,
      });
      expect(await connectionSettings(pool)).toEqual({
        ...before,
        search_path: '"$user", public',
        application_name: '',
        work_mem: '4MB',
        flavor: '',
        time_zone: expect.not.stringMatching(/^America\/Sao_Paulo$/),
      });
    } finally {
      await pool.end();
    }
  });

  it('уборка соединения: параметры стартового пакета (options, application_name) и ALTER ROLE … SET переживают withScope', async () => {
    const { role } = await database.extraRole('baseline');
    await database.admin.query(`ALTER ROLE ${role} SET statement_timeout = '7s'`);
    const url = new URL(database.urls.app);
    url.username = role;
    const started = new Pool({
      connectionString: url.toString(),
      max: 1,
      options: '-c search_path=scope_kept,public -c TimeZone=Asia/Tokyo',
      application_name: 'scope-service',
    });
    try {
      const before = await connectionSettings(started);
      expect(before).toMatchObject({
        search_path: 'scope_kept,public',
        time_zone: 'Asia/Tokyo',
        application_name: 'scope-service',
        statement_timeout: '7s',
      });
      await withScope(drizzle(started), scope, PROJECT.a, async () => undefined);
      expect(await connectionSettings(started)).toEqual(before);
    } finally {
      await started.end();
    }
  });

  it('временная таблица и курсор WITH HOLD работы области A не достаются работе области B на том же соединении', async () => {
    const single = drizzle(database.pool('app', 1));
    await withScope(single, scope, PROJECT.a, async (_tx, client) => {
      await client.query('CREATE TEMP TABLE staging (body text)');
      await client.query('INSERT INTO staging SELECT body FROM items');
      await client.query('DECLARE held CURSOR WITH HOLD FOR SELECT body FROM items');
    });
    const left = await withScope(single, scope, PROJECT.b, async (_tx, client) => {
      const { rows } = await client.query<{ staging: string | null }>(
        "SELECT to_regclass('pg_temp.staging')::text AS staging",
      );
      return rows[0]?.staging;
    });
    expect(left).toBeNull();
    const cursor = await rejectionOf(
      withScope(single, scope, PROJECT.b, (_tx, client) => client.query('FETCH ALL FROM held')),
    );
    expect(sqlStateOf(cursor)).toBe('34000');
    // Выключить уборку нельзя: состояние одной области досталось бы другой (JS без типов — отказ рантайма).
    const refused = await rejectionOf(
      withScope(single, scope, PROJECT.a, async () => undefined, { resetSession: false } as never),
    );
    expect(String(refused)).toContain('resetSession: false');
  });

  it('запрос, отложенный работой, после её возврата — отказ: ни запись, ни сессионный контекст не проходят мимо проверки', async () => {
    const single = database.pool('app', 1);
    let late: Promise<unknown> = Promise.resolve();
    await withScope(drizzle(single), scope, PROJECT.a, async (_tx, client) => {
      setImmediate(() => {
        late = Promise.resolve().then(() =>
          Promise.all([
            client.query("SELECT set_config('app.project_id', $1, false)", [PROJECT.b]),
            client.query("UPDATE items SET body = body || ' (поздно)'"),
          ]),
        );
      });
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await rejectionOf(late)).toBeInstanceOf(TransactionClientMisuseError);
    expect(await bodiesOf(single, 'items')).toEqual([]);
    expect(await bodiesOf(database.admin, 'items')).toEqual(['a.1', 'a.2', 'b.1']);
  });

  it('под transactionPooler сессионный set_config в обход текстового фильтра (EXECUTE в DO) не остаётся соседу', async () => {
    const single = database.pool('app', 1);
    const inWork = await withScope(
      drizzle(single),
      scope,
      PROJECT.a,
      async (_tx, client) => {
        await client.query(sessionSetByExecute('app.project_id', PROJECT.a));
        const { rows } = await client.query<{ value: string }>(
          "SELECT current_setting('app.project_id') AS value",
        );
        return rows[0]?.value;
      },
      { transactionPooler: true },
    );
    // Фильтр пропустил: значение в работе задано (иначе проверка ниже ничего не доказывала бы).
    expect(inWork).toBe(PROJECT.a);
    expect(await bodiesOf(single, 'items')).toEqual([]);
    expect(
      (
        await single.query<{ value: string | null }>(
          "SELECT current_setting('app.project_id', true) AS value",
        )
      ).rows[0]?.value,
    ).toBe('');
  });

  it('TRUNCATE в работе области — отказ сервера: право отозвано миграцией, строки всех областей на месте', async () => {
    const error = await rejectionOf(
      withScope(database.appDb, scope, PROJECT.a, (_tx, client) => client.query('TRUNCATE items')),
    );
    expect(sqlStateOf(error)).toBe('42501');
    expect(await bodiesOf(database.admin, 'items')).toEqual(['a.1', 'a.2', 'b.1']);
  });
});

/**
 * Сентинел «не задано»: после первой транзакции с контекстом параметр в сессии
 * существует и равен '' — и строка с пустой областью (text) совпала бы с ним,
 * если бы политика сравнивала без NULLIF.
 */
describeDb('пустая область text не совпадает с «не задано» [нужен PG_TEST_URL]', () => {
  let database: ScopeTestDatabase;
  let scope: ProjectScope;

  beforeAll(async () => {
    database = await createScopeTestDatabase();
    scope = defineProjectScope({
      setting: 'app.tenant',
      column: 'tenant',
      columnType: SCOPE_COLUMN_TYPE.text,
      tables: ['labels'],
    });
    await database.app.query(
      `CREATE TABLE labels (tenant text NOT NULL, body text NOT NULL); ${scopePolicySql(scope)}`,
    );
    await database.admin.query("INSERT INTO labels VALUES ('', 'empty-tenant'), ('x', 'x.1')");
  });
  afterAll(async () => {
    await database?.drop();
  });

  it('до и после транзакции с контекстом запрос без контекста не видит строку с пустой областью', async () => {
    const single = database.pool('app', 1);
    expect(await bodiesOf(single, 'labels')).toEqual([]);
    const inside = await withScope(drizzle(single), scope, 'x', async (_tx, client) =>
      bodies(client, 'labels'),
    );
    expect(inside).toEqual(['x.1']);
    const { rows } = await single.query<{ context: string | null }>(
      "SELECT current_setting('app.tenant', true) AS context",
    );
    expect(rows[0]?.context).toBe('');
    expect(await bodiesOf(single, 'labels')).toEqual([]);
    expect(await bodiesOf(database.admin, 'labels')).toEqual(['empty-tenant', 'x.1']);
  });
});
