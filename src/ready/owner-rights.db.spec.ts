import { drizzle } from 'drizzle-orm/node-postgres';

import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { SCOPE_PROBLEM } from '../constants/scope-problem.constant';
import { withScope } from '../context/with-scope';
import { ScopeConflictError } from '../errors/scope-conflict.error';
import { defineProjectScope } from '../scope/define-project-scope';
import { bodiesOf } from '../testing/bodies-of';
import { createScopeTables } from '../testing/create-scope-tables';
import { describeDb } from '../testing/describe-db';
import { problemsOf } from '../testing/problems-of';
import { PROJECT } from '../testing/project.constant';
import { rejectionOf } from '../testing/rejection-of';
import { createScopeTestDatabase } from '../testing/scope-test-database';
import type { ScopeTestDatabase } from '../testing/scope-test-database.type';
import type { ProjectScope } from '../types/project-scope.type';

/**
 * Пути мимо политик, которых нет в таблицах: код с правами владельца
 * (SECURITY DEFINER по EXECUTE, триггером, событийным триггером), параметр
 * области в определении функции, LEAKPROOF, сопоставление пользователя
 * внешнего сервера, причина сквозного доступа на роли, атрибут роли через
 * членство. Каждый обход — настоящий (область A видит или меняет строки B),
 * рядом — легитимный двойник без ложного отказа. Всё — под ролью приложения
 * без суперправ и BYPASSRLS; суперпользователь только строит фикстуру.
 */
describeDb('assertScopeReady: права владельца и пути мимо таблиц [нужен PG_TEST_URL]', () => {
  let database: ScopeTestDatabase;
  let scope: ProjectScope;
  let version = 0;

  beforeAll(async () => {
    database = await createScopeTestDatabase();
    scope = defineProjectScope({
      setting: 'app.project_id',
      column: 'project_id',
      columnType: SCOPE_COLUMN_TYPE.uuid,
      tables: ['items', 'notes'],
      maintenanceRole: database.roles.maintenance,
    });
    version = Number(
      (await database.admin.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0]
        ?.v,
    );
  });
  beforeEach(async () => {
    await createScopeTables(database, scope);
  });
  afterEach(async () => {
    await database.admin.query(`DROP OWNED BY ${database.roles.app}`);
  });
  afterAll(async () => {
    await database?.drop();
  });

  const inA = async (sql: string, params: unknown[] = []): Promise<string[]> =>
    withScope(database.appDb, scope, PROJECT.a, async (_tx, client) =>
      (await client.query<{ body: string }>(sql, params)).rows.map((row) => row.body).sort(),
    );

  it('SECURITY DEFINER суперпользователя с EXECUTE у PUBLIC — security-definer; владелец без обхода RLS, своя функция роли и функция без EXECUTE — готово', async () => {
    await database.admin.query(
      "CREATE FUNCTION public.all_bodies() RETURNS SETOF text LANGUAGE sql SECURITY DEFINER AS 'SELECT body FROM items'",
    );
    try {
      // Обход настоящий: в работе области A функция отдаёт строку B.
      expect(await inA('SELECT b AS body FROM public.all_bodies() AS b')).toEqual(['a.1', 'a.2', 'b.1']);
      expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.securityDefiner, null]]);
      // У области без роли сквозного доступа — тот же ответ: суперпользователь судится сам по себе.
      const withoutRole = defineProjectScope({
        setting: scope.setting,
        column: scope.column,
        columnType: scope.columnType,
        tables: [...scope.tables],
      });
      expect(await problemsOf(database.app, withoutRole)).toEqual([[SCOPE_PROBLEM.securityDefiner, null]]);
      // Владелец с BYPASSRLS (не суперпользователь) — тоже обходит политики.
      const bypass = await database.extraRole('bypassowner', 'BYPASSRLS');
      await database.admin.query(
        `GRANT SELECT ON items TO ${bypass.role}; ALTER FUNCTION public.all_bodies() OWNER TO ${bypass.role}`,
      );
      expect(await inA('SELECT b AS body FROM public.all_bodies() AS b')).toEqual(['a.1', 'a.2', 'b.1']);
      expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.securityDefiner, null]]);
      // Двойник: владелец — роль без обхода RLS, политики области для неё те же.
      await database.admin.query(`ALTER FUNCTION public.all_bodies() OWNER TO ${database.roles.reader}`);
      expect(await inA('SELECT b AS body FROM public.all_bodies() AS b')).toEqual(['a.1', 'a.2']);
      expect(await problemsOf(database.app, scope)).toBe('ready');
      // Двойник: функция суперпользователя, которую роли сессии не исполнить.
      await database.admin.query(`
        ALTER FUNCTION public.all_bodies() OWNER TO CURRENT_USER;
        REVOKE EXECUTE ON FUNCTION public.all_bodies() FROM PUBLIC;
      `);
      expect(await problemsOf(database.app, scope)).toBe('ready');
      // Двойник: своя функция роли приложения с правами владельца — она же проходит политики под FORCE.
      await database.app.query(
        "CREATE FUNCTION own_bodies() RETURNS SETOF text LANGUAGE sql SECURITY DEFINER AS 'SELECT body FROM items'",
      );
      expect(await inA('SELECT b AS body FROM own_bodies() AS b')).toEqual(['a.1', 'a.2']);
      expect(await problemsOf(database.app, scope)).toBe('ready');
    } finally {
      await database.admin.query('DROP FUNCTION IF EXISTS public.all_bodies()');
    }
  });

  it('SECURITY DEFINER, чей владелец с REPLICATION, CREATEROLE или во встроенных ролях файлов сервера: запросы тела проходят политики — готово; двойник BYPASSRLS — security-definer', async () => {
    await database.admin.query(
      "CREATE FUNCTION public.owner_bodies() RETURNS SETOF text LANGUAGE sql SECURITY DEFINER AS 'SELECT body FROM items'",
    );
    for (const [label, attributes, grant] of [
      ['repl', 'REPLICATION', ''],
      ['crole', 'CREATEROLE', ''],
      [
        'files',
        '',
        'GRANT pg_read_server_files, pg_write_server_files, pg_execute_server_program TO {role};',
      ],
    ] as const) {
      const owner = await database.extraRole(`owner${label}`, attributes);
      await database.admin.query(
        `${grant.replaceAll('{role}', owner.role)} GRANT SELECT ON items TO ${owner.role};` +
          ` ALTER FUNCTION public.owner_bodies() OWNER TO ${owner.role}`,
      );
      // Атрибут владельца RLS с запросов тела не снимает: область A видит свои строки.
      expect([label, await inA('SELECT b AS body FROM public.owner_bodies() AS b')]).toEqual([
        label,
        ['a.1', 'a.2'],
      ]);
      expect([label, await problemsOf(database.app, scope)]).toEqual([label, 'ready']);
    }
    const bypass = await database.extraRole('ownerbypass', 'BYPASSRLS');
    await database.admin.query(
      `GRANT SELECT ON items TO ${bypass.role}; ALTER FUNCTION public.owner_bodies() OWNER TO ${bypass.role}`,
    );
    expect(await inA('SELECT b AS body FROM public.owner_bodies() AS b')).toEqual(['a.1', 'a.2', 'b.1']);
    expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.securityDefiner, null]]);
    // Функция чужого владельца: DROP OWNED роли приложения её не снимет.
    await database.admin.query('DROP FUNCTION public.owner_bodies()');
  });

  it('процедура суперпользователя и функция роли сквозного доступа с правами владельца — security-definer у каждой', async () => {
    await database.admin.query(`
      CREATE PROCEDURE public.count_all(INOUT n bigint) LANGUAGE plpgsql SECURITY DEFINER
        AS $$BEGIN SELECT count(*) INTO n FROM items; END$$;
      CREATE FUNCTION public.maint_bodies() RETURNS SETOF text LANGUAGE sql SECURITY DEFINER AS 'SELECT body FROM items';
      ALTER FUNCTION public.maint_bodies() OWNER TO ${database.roles.maintenance};
    `);
    try {
      expect(
        await withScope(database.appDb, scope, PROJECT.a, async (_tx, client) =>
          Number((await client.query<{ n: string }>('CALL public.count_all(0)')).rows[0]?.n),
        ),
      ).toBe(3);
      // Без контекста политика сквозного доступа пропускает всё: запрос мимо withScope видит все области.
      expect(
        (await database.app.query<{ body: string }>('SELECT b AS body FROM public.maint_bodies() AS b')).rows
          .map((row) => row.body)
          .sort(),
      ).toEqual(['a.1', 'a.2', 'b.1']);
      const problems = await problemsOf(database.app, scope);
      expect(problems).toEqual([
        [SCOPE_PROBLEM.securityDefiner, null],
        [SCOPE_PROBLEM.securityDefiner, null],
      ]);
    } finally {
      await database.admin.query(
        'DROP PROCEDURE public.count_all(bigint); DROP FUNCTION public.maint_bodies()',
      );
    }
  });

  it('триггер и событийный триггер с функцией SECURITY DEFINER — security-definer без EXECUTE у сессии; триггер на таблице только для чтения — готово', async () => {
    await database.admin.query(`
      CREATE FUNCTION public.wipe_items() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
        AS $$BEGIN DELETE FROM items WHERE body = NEW.body; RETURN NEW; END$$;
      REVOKE EXECUTE ON FUNCTION public.wipe_items() FROM PUBLIC;
      CREATE TABLE public.read_only (body text);
      GRANT SELECT ON public.read_only TO ${database.roles.app};
      CREATE TRIGGER t_wipe AFTER INSERT ON public.read_only FOR EACH ROW EXECUTE FUNCTION public.wipe_items();
    `);
    try {
      expect(await problemsOf(database.app, scope)).toBe('ready');
      await database.admin.query(
        'CREATE TRIGGER t_wipe AFTER INSERT ON notes FOR EACH ROW EXECUTE FUNCTION public.wipe_items()',
      );
      // Обход настоящий: вставка из работы области A удаляет строку B.
      await withScope(database.appDb, scope, PROJECT.a, (_tx, client) =>
        client.query("INSERT INTO notes (project_id, body) VALUES ($1, 'b.1')", [PROJECT.a]),
      );
      expect(await bodiesOf(database.admin, 'items')).toEqual(['a.1', 'a.2']);
      expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.securityDefiner, null]]);
      await database.admin.query(`
        DROP TRIGGER t_wipe ON notes;
        CREATE FUNCTION public.on_ddl() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER AS $$BEGIN NULL; END$$;
        REVOKE EXECUTE ON FUNCTION public.on_ddl() FROM PUBLIC;
        CREATE EVENT TRIGGER scope_on_ddl ON ddl_command_end EXECUTE FUNCTION public.on_ddl();
      `);
      expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.securityDefiner, null]]);
    } finally {
      await database.admin.query(`
        DROP EVENT TRIGGER IF EXISTS scope_on_ddl;
        DROP FUNCTION IF EXISTS public.on_ddl();
        DROP TABLE public.read_only;
        DROP FUNCTION public.wipe_items() CASCADE;
      `);
    }
  });

  it('параметр области или причины в определении функции — routine-sets-scope; SET search_path в определении — готово', async () => {
    // Роль приложения такую функцию создать не может — только суперпользователь.
    expect(
      await rejectionOf(
        database.app.query(
          `CREATE FUNCTION own_b() RETURNS int LANGUAGE sql SET app.project_id = '${PROJECT.b}' AS 'SELECT 1'`,
        ),
      ),
    ).toMatchObject({ code: '42501' });
    await database.admin.query(`
      CREATE FUNCTION public.path_fixed() RETURNS SETOF text LANGUAGE sql SET search_path = public AS 'SELECT body FROM items';
      ALTER FUNCTION public.path_fixed() OWNER TO ${database.roles.app};
    `);
    expect(await problemsOf(database.app, scope)).toBe('ready');
    await database.admin.query(`
      CREATE FUNCTION public.b_bodies() RETURNS SETOF text LANGUAGE sql SET app.project_id = '${PROJECT.b}' AS 'SELECT body FROM items';
      ALTER FUNCTION public.b_bodies() OWNER TO ${database.roles.app};
      CREATE FUNCTION public.with_reason() RETURNS int LANGUAGE sql SET "App.Project_Id_Cross_Reason" = 'ночная очистка' AS 'SELECT 1';
      ALTER FUNCTION public.with_reason() OWNER TO ${database.roles.app};
    `);
    // Обход настоящий: в работе области A функция видит область B, и сверка к концу работы этого не замечает.
    expect(await inA('SELECT b AS body FROM public.b_bodies() AS b')).toEqual(['b.1']);
    expect(await problemsOf(database.app, scope)).toEqual([
      [SCOPE_PROBLEM.routineSetsScope, null],
      [SCOPE_PROBLEM.routineSetsScope, null],
    ]);
  });

  it('LEAKPROOF вне pg_catalog — leakproof-function; встроенные LEAKPROOF и такая функция без EXECUTE — готово', async () => {
    await database.admin.query(`
      CREATE FUNCTION public.peek(text) RETURNS boolean LANGUAGE plpgsql LEAKPROOF COST 0.0000001
        AS $$BEGIN RAISE NOTICE 'peek:%', $1; RETURN true; END$$;
    `);
    try {
      const single = database.pool('app', 1);
      const seen: string[] = [];
      single.on('connect', (client) => client.on('notice', (notice) => seen.push(notice.message ?? '')));
      await withScope(drizzle(single), scope, PROJECT.a, (_tx, client) =>
        client.query('SELECT body FROM notes WHERE public.peek(body)'),
      );
      // Обход настоящий: условие вычислено до политики — на строке области B (notes без индекса по области).
      expect(seen).toContain('peek:b.note');
      expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.leakproofFunction, null]]);
      await database.admin.query('REVOKE EXECUTE ON FUNCTION public.peek(text) FROM PUBLIC');
      expect(await problemsOf(database.app, scope)).toBe('ready');
    } finally {
      await database.admin.query('DROP FUNCTION public.peek(text)');
    }
  });

  it('сопоставление пользователя внешнего сервера для роли сессии или PUBLIC — user-mapping; для чужой роли — готово', async () => {
    const { rows } = await database.admin.query<{ db: string }>('SELECT current_database() AS db');
    await database.admin.query(`
      CREATE EXTENSION IF NOT EXISTS postgres_fdw;
      CREATE SERVER scope_self FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host '127.0.0.1', port '5432', dbname '${rows[0]?.db}');
      GRANT USAGE ON FOREIGN SERVER scope_self TO ${database.roles.app};
      CREATE USER MAPPING FOR ${database.roles.reader} SERVER scope_self OPTIONS (user '${database.roles.maintenance}', password 'app');
    `);
    try {
      expect(await problemsOf(database.app, scope)).toBe('ready');
      await database.admin.query(
        `CREATE USER MAPPING FOR ${database.roles.app} SERVER scope_self OPTIONS (user '${database.roles.maintenance}', password 'app', password_required 'false')`,
      );
      await database.app.query(
        "CREATE FOREIGN TABLE leak_ft (body text) SERVER scope_self OPTIONS (table_name 'items')",
      );
      // Обход настоящий: внешняя таблица без колонки области читает данные под ролью сквозного доступа.
      expect(await inA('SELECT body FROM leak_ft')).toEqual(['a.1', 'a.2', 'b.1']);
      expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.userMapping, null]]);
      await database.admin.query(`
        DROP USER MAPPING FOR ${database.roles.app} SERVER scope_self;
        CREATE USER MAPPING FOR PUBLIC SERVER scope_self OPTIONS (user '${database.roles.maintenance}', password 'app');
      `);
      expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.userMapping, null]]);
    } finally {
      await database.admin.query('DROP SERVER scope_self CASCADE; DROP EXTENSION postgres_fdw');
    }
  });

  it('причина сквозного доступа на роли (ALTER ROLE … SET) — context-outside-transaction: иначе каждая работа области падает', async () => {
    await database.admin.query(
      `ALTER ROLE ${database.roles.app} SET ${scope.reasonSetting} = 'осталось от отладки ночной очистки'`,
    );
    try {
      const fresh = database.pool('app', 1);
      expect(
        await rejectionOf(withScope(drizzle(fresh), scope, PROJECT.a, async () => 'работа')),
      ).toBeInstanceOf(ScopeConflictError);
      expect(await problemsOf(fresh, scope)).toEqual([[SCOPE_PROBLEM.contextOutsideTransaction, null]]);
    } finally {
      await database.admin.query(`ALTER ROLE ${database.roles.app} RESET ${scope.reasonSetting}`);
    }
  });

  it('CREATEROLE у роли, в которую сессия входит: ниже Postgres 16 — escalation (выдаёт себе роль сквозного доступа), с 16 — путь закрыт сервером', async () => {
    const admins = await database.extraRole('admins', 'CREATEROLE');
    const member = await database.extraRole('createrolemember');
    await database.admin.query(`
      GRANT SELECT ON items, notes TO ${member.role};
      GRANT ${admins.role} TO ${member.role};
    `);
    const client = await member.pool.connect();
    let granted: unknown;
    try {
      await client.query(`SET ROLE ${admins.role}`);
      granted = await client.query(`GRANT ${database.roles.maintenance} TO ${member.role}`).then(
        () => 'выдано',
        (error: { code?: string }) => error.code,
      );
    } finally {
      client.release(true);
      await database.admin.query(`REVOKE ${database.roles.maintenance} FROM ${member.role}`);
    }
    if (version < 160000) {
      expect(granted).toBe('выдано');
      expect(await problemsOf(member.pool, scope)).toEqual([[SCOPE_PROBLEM.escalation, null]]);
    } else {
      expect(granted).toBe('42501');
      expect(await problemsOf(member.pool, scope)).toBe('ready');
    }
  });

  it('разрешающая политика USING (false) и WITH CHECK (false) ничего не открывает — готово; USING (true) — foreign-policy', async () => {
    await database.app.query(`
      CREATE POLICY never_read ON items USING (false);
      CREATE POLICY never_write ON notes FOR INSERT WITH CHECK (false);
    `);
    expect(await problemsOf(database.app, scope)).toBe('ready');
    await database.app.query('CREATE POLICY open_read ON items FOR SELECT USING (true)');
    expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.foreignPolicy, 'items']]);
  });

  it('право только REFERENCES или TRIGGER на таблицу с колонкой области вне списка строк не отдаёт — готово; SELECT — unlisted-table', async () => {
    await database.admin.query(`
      CREATE TABLE public.ref_only (id int PRIMARY KEY, project_id uuid, body text);
      GRANT REFERENCES, TRIGGER ON public.ref_only TO ${database.roles.app};
      GRANT REFERENCES (id) ON public.ref_only TO ${database.roles.app};
    `);
    try {
      expect(await problemsOf(database.app, scope)).toBe('ready');
      await database.admin.query(`GRANT SELECT (body) ON public.ref_only TO ${database.roles.app}`);
      expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.unlistedTable, 'ref_only']]);
    } finally {
      await database.admin.query('DROP TABLE public.ref_only');
    }
  });

  it('членство без INHERIT и без SET (Postgres 16+) не даёт ни прав, ни SET ROLE — готово; с ADMIN OPTION — права роли считаются', async () => {
    const viewer = await database.extraRole('inert');
    const rich = await database.extraRole('truncator');
    await database.admin.query(`GRANT SELECT ON items, notes TO ${viewer.role}`);
    await database.app.query(`GRANT TRUNCATE ON items TO ${rich.role}`);
    if (version < 160000) {
      // Ниже 16 такой записи членства нет вовсе.
      expect(
        await rejectionOf(database.admin.query(`GRANT ${rich.role} TO ${viewer.role} WITH INHERIT FALSE`)),
      ).toMatchObject({ code: '42601' });
      return;
    }
    await database.admin.query(`GRANT ${rich.role} TO ${viewer.role} WITH INHERIT FALSE, SET FALSE`);
    const client = await viewer.pool.connect();
    try {
      expect(await rejectionOf(client.query(`SET ROLE ${rich.role}`))).toMatchObject({ code: '42501' });
    } finally {
      client.release(true);
    }
    expect(await problemsOf(viewer.pool, scope)).toBe('ready');
    await database.admin.query(`
      REVOKE ${rich.role} FROM ${viewer.role};
      GRANT ${rich.role} TO ${viewer.role} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    `);
    expect(await problemsOf(viewer.pool, scope)).toEqual([[SCOPE_PROBLEM.truncatePrivilege, 'items']]);
  });

  it('чистая база с расширениями contrib: ни одной ложной причины (функции расширений с правами владельца EXECUTE у PUBLIC не имеют)', async () => {
    const extensions = [
      'pgcrypto',
      'pg_trgm',
      'uuid-ossp',
      'postgres_fdw',
      'dblink',
      'pg_buffercache',
      'pgstattuple',
      'hstore',
      'citext',
      'btree_gist',
      'btree_gin',
      'tablefunc',
      'pg_visibility',
      'amcheck',
      'pgrowlocks',
      'pg_walinspect',
      'pageinspect',
      'intarray',
      'ltree',
      'fuzzystrmatch',
      'unaccent',
      'lo',
      'seg',
      'cube',
      'earthdistance',
      'tcn',
      'sslinfo',
      'isn',
      'pg_freespacemap',
      'pg_prewarm',
      'pg_surgery',
      'pg_stat_statements',
      'file_fdw',
      'tsm_system_rows',
    ];
    const created: string[] = [];
    try {
      for (const name of extensions) {
        const ok = await database.admin.query(`CREATE EXTENSION IF NOT EXISTS "${name}" CASCADE`).then(
          () => true,
          () => false,
        );
        if (ok) {
          created.push(name);
        }
      }
      expect(created.length).toBeGreaterThanOrEqual(25);
      const { rows } = await database.admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_proc WHERE prosecdef AND pronamespace <> 'pg_catalog'::regnamespace",
      );
      // Выборка не выродилась: функции с правами владельца в расширениях есть.
      expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
      expect(await problemsOf(database.app, scope)).toBe('ready');
    } finally {
      for (const name of created.reverse()) {
        await database.admin.query(`DROP EXTENSION IF EXISTS "${name}" CASCADE`);
      }
    }
  }, 60_000);
});
