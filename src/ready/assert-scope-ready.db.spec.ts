import { Pool } from 'pg';

import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { SCOPE_PROBLEM } from '../constants/scope-problem.constant';
import { ScopeNotReadyError } from '../errors/scope-not-ready.error';
import { scopePolicySql } from '../policy/scope-policy-sql';
import { defineProjectScope } from '../scope/define-project-scope';
import { scopePredicateSql } from '../scope/scope-predicate-sql';
import { bodiesOf } from '../testing/bodies-of';
import { createScopeTables } from '../testing/create-scope-tables';
import { describeDb } from '../testing/describe-db';
import { problemsOf } from '../testing/problems-of';
import { createScopeTestDatabase } from '../testing/scope-test-database';
import type { ScopeTestDatabase } from '../testing/scope-test-database.type';
import type { ProjectScope } from '../types/project-scope.type';
import type { ScopeColumnType } from '../types/scope-column-type.type';
import { assertScopeReady } from './assert-scope-ready';

describeDb('assertScopeReady: изоляция действует для роли пула [нужен PG_TEST_URL]', () => {
  let database: ScopeTestDatabase;
  let counter = 0;

  beforeAll(async () => {
    database = await createScopeTestDatabase();
  });
  afterAll(async () => {
    await database?.drop();
  });
  // Проверка судит ВЕСЬ каталог: таблица прошлого теста с колонкой области была бы
  // «вне списка» для следующего. Каждый тест начинает с пустой базы.
  afterEach(async () => {
    await database.admin.query(`DROP OWNED BY ${database.roles.app}`);
  });

  const scopeOf = (tables: string[], columnType: ScopeColumnType = SCOPE_COLUMN_TYPE.uuid): ProjectScope =>
    defineProjectScope({
      setting: 'app.project_id',
      column: 'project_id',
      columnType,
      tables,
      maintenanceRole: database.roles.maintenance,
    });

  /** Новая таблица роли приложения; `protect` — SQL защиты (по умолчанию — из пакета). */
  const table = async (
    protect: (scope: ProjectScope, name: string) => string = (scope) => scopePolicySql(scope),
    column = 'project_id uuid NOT NULL',
    columnType: ScopeColumnType = SCOPE_COLUMN_TYPE.uuid,
  ): Promise<{ name: string; scope: ProjectScope }> => {
    counter += 1;
    const name = `t${counter}`;
    const scope = scopeOf([name], columnType);
    await database.app.query(`CREATE TABLE ${name} (id serial PRIMARY KEY, ${column})`);
    await database.app.query(protect(scope, name));
    // Право TRUNCATE владельца снимается и там, где защита написана руками: этот набор — о политиках.
    await database.app.query(`REVOKE TRUNCATE ON ${name} FROM CURRENT_USER`);
    await database.app.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${name} TO ${database.roles.reader}`);
    return { name, scope };
  };

  it('защита из пакета: готово и для владельца таблиц, и для роли с GRANT', async () => {
    const { scope } = await table();
    expect(await problemsOf(database.app, scope)).toEqual('ready');
    expect(await problemsOf(database.reader, scope)).toEqual('ready');
  });

  it('политика в форме drizzle-kit (TO public) совпадает с эталоном', async () => {
    const { scope } = await table(
      (s, name) =>
        `ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY; ALTER TABLE "${name}" FORCE ROW LEVEL SECURITY; ` +
        `CREATE POLICY "${s.policyName}" ON "${name}" AS PERMISSIVE FOR ALL TO public USING (${scopePredicateSql(s)}) WITH CHECK (${scopePredicateSql(s)})`,
    );
    expect(await problemsOf(database.app, scope)).toEqual('ready');
  });

  it('под суперпользователем изоляция не проверяется: он видит все строки, и проверка это ловит', async () => {
    const scope = defineProjectScope({
      setting: 'app.project_id',
      column: 'project_id',
      columnType: SCOPE_COLUMN_TYPE.uuid,
      tables: ['items', 'notes'],
    });
    await createScopeTables(database, scope);
    // Набор под суперпользователем был бы зелёным при любой политике: без контекста он видит всё.
    expect(await bodiesOf(database.admin, 'items')).toEqual(['a.1', 'a.2', 'b.1']);
    expect(await bodiesOf(database.app, 'items')).toEqual([]);
    expect(await problemsOf(database.admin, scope)).toEqual([
      [SCOPE_PROBLEM.bypassRls, null],
      [SCOPE_PROBLEM.superuser, null],
      [SCOPE_PROBLEM.truncatePrivilege, 'items'],
      [SCOPE_PROBLEM.truncatePrivilege, 'notes'],
    ]);
    expect(await problemsOf(database.app, scope)).toEqual('ready');
  });

  it('BYPASSRLS, членство в роли с BYPASSRLS и в роли сквозного доступа — отказ', async () => {
    const { scope } = await table();
    const bypass = await database.extraRole('bypass', 'BYPASSRLS');
    const member = await database.extraRole('member');
    const maintenanceMember = await database.extraRole('maintmember');
    await database.admin.query(`GRANT ${bypass.role} TO ${member.role}`);
    await database.admin.query(`GRANT ${database.roles.maintenance} TO ${maintenanceMember.role}`);
    expect(await problemsOf(bypass.pool, scope)).toEqual([[SCOPE_PROBLEM.bypassRls, null]]);
    expect(await problemsOf(member.pool, scope)).toEqual([[SCOPE_PROBLEM.escalation, null]]);
    // Политика сквозного доступа — своя (эталонной формы): причина — сама роль, а не «чужая политика».
    expect(await problemsOf(maintenanceMember.pool, scope)).toEqual([
      [SCOPE_PROBLEM.memberOfMaintenanceRole, null],
    ]);
    expect(await problemsOf(database.maintenance, scope)).toEqual([[SCOPE_PROBLEM.maintenanceRole, null]]);
  });

  it('контекст области вне транзакции (сессионный SET остался на соединении) — отказ', async () => {
    const { scope } = await table();
    const single = database.pool('app', 1);
    await single.query("SET app.project_id = '0a0a0a0a-0000-4000-8000-00000000000a'");
    expect(await problemsOf(single, scope)).toEqual([[SCOPE_PROBLEM.contextOutsideTransaction, null]]);
    // Значение области в текст отказа не попадает: он уходит в логи.
    await expect(assertScopeReady(single, scope)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('0a0a0a0a') }),
    );
    await single.query('RESET app.project_id');
    expect(await problemsOf(single, scope)).toEqual('ready');
  });

  it('нет таблицы; RLS выключен и политики нет', async () => {
    expect(await problemsOf(database.app, scopeOf(['absent']))).toEqual([
      [SCOPE_PROBLEM.tableMissing, 'absent'],
    ]);
    const { name, scope } = await table(() => 'SELECT 1');
    expect(await problemsOf(database.app, scope)).toEqual([
      [SCOPE_PROBLEM.policyMissing, name],
      [SCOPE_PROBLEM.rlsDisabled, name],
    ]);
  });

  it('без FORCE: владелец — owner-without-force, роль с GRANT — rls-not-forced', async () => {
    const { name, scope } = await table(
      (s, n) => `${scopePolicySql(s)} ALTER TABLE ${n} NO FORCE ROW LEVEL SECURITY;`,
    );
    expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.ownerWithoutForce, name]]);
    expect(await problemsOf(database.reader, scope)).toEqual([[SCOPE_PROBLEM.rlsNotForced, name]]);
  });

  it('политика не та: пропускает при пустом контексте, без WITH CHECK, WITH CHECK (true), не ALL, RESTRICTIVE, не на роль', async () => {
    const both = (s: ProjectScope) => `USING (${scopePredicateSql(s)}) WITH CHECK (${scopePredicateSql(s)})`;
    const variants = [
      (s: ProjectScope) =>
        `USING (current_setting('app.project_id', true) IS NULL OR ${scopePredicateSql(s)}) WITH CHECK (${scopePredicateSql(s)})`,
      (s: ProjectScope) => `USING (${scopePredicateSql(s)})`,
      (s: ProjectScope) => `USING (${scopePredicateSql(s)}) WITH CHECK (true)`,
      // Выражения совпадают с эталоном — отличие только в команде, виде или ролях.
      (s: ProjectScope) => `FOR UPDATE ${both(s)}`,
      (s: ProjectScope) => `AS RESTRICTIVE ${both(s)}`,
      (s: ProjectScope) => `TO ${database.roles.reader} ${both(s)}`,
    ];
    for (const variant of variants) {
      const { name, scope } = await table(
        (s, n) =>
          `ALTER TABLE ${n} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${n} FORCE ROW LEVEL SECURITY; ` +
          `CREATE POLICY ${s.policyName} ON ${n} ${variant(s)}`,
      );
      expect([variant(scope), await problemsOf(database.app, scope)]).toEqual([
        variant(scope),
        [[SCOPE_PROBLEM.policyMismatch, name]],
      ]);
      await database.app.query(`DROP TABLE ${name}`);
    }
  });

  it('чужая разрешающая политика на роль — отказ; ограничивающая и чужой роли — нет', async () => {
    const open = await table((s, n) => `${scopePolicySql(s)} CREATE POLICY open_all ON ${n} USING (true);`);
    expect(await problemsOf(database.app, open.scope)).toEqual([[SCOPE_PROBLEM.foreignPolicy, open.name]]);
    await database.app.query(`DROP TABLE ${open.name}`);
    const narrowing = await table(
      (s, n) =>
        `${scopePolicySql(s)} CREATE POLICY narrow ON ${n} AS RESTRICTIVE USING (id > 0); ` +
        `CREATE POLICY reader_only ON ${n} TO ${database.roles.reader} USING (true);`,
    );
    expect(await problemsOf(database.app, narrowing.scope)).toEqual('ready');
    expect(await problemsOf(database.reader, narrowing.scope)).toEqual([
      [SCOPE_PROBLEM.foreignPolicy, narrowing.name],
    ]);
  });

  it('колонка области не того типа — отказ', async () => {
    const { name, scope } = await table(undefined, 'project_id integer NOT NULL', SCOPE_COLUMN_TYPE.bigint);
    expect(await problemsOf(database.app, scope)).toEqual([[SCOPE_PROBLEM.columnMismatch, name]]);
  });

  it('секция без защиты — отказ по секции: запрос прямо к ней проходит её политики, а не родителя', async () => {
    counter += 1;
    const name = `t${counter}`;
    const scope = scopeOf([name]);
    await database.app.query(
      `CREATE TABLE ${name} (id int NOT NULL, project_id uuid NOT NULL) PARTITION BY HASH (project_id); ${scopePolicySql(scope)}`,
    );
    await database.app.query(
      `CREATE TABLE ${name}_p0 PARTITION OF ${name} FOR VALUES WITH (MODULUS 2, REMAINDER 0)`,
    );
    await database.app.query(
      `CREATE TABLE ${name}_p1 PARTITION OF ${name} FOR VALUES WITH (MODULUS 2, REMAINDER 1); ${scopePolicySql(scope, { tables: [`${name}_p1`] })}`,
    );
    expect(await problemsOf(database.app, scope)).toEqual([
      [SCOPE_PROBLEM.policyMissing, `${name}/${name}_p0`],
      [SCOPE_PROBLEM.rlsDisabled, `${name}/${name}_p0`],
      [SCOPE_PROBLEM.truncatePrivilege, `${name}/${name}_p0`],
    ]);
    await database.app.query(scopePolicySql(scope, { tables: [`${name}_p0`] }));
    expect(await problemsOf(database.app, scope)).toEqual('ready');
  });

  it('проверку не выполнить (нет права TEMP для эталона) — отказ undetermined, а не «готово»', async () => {
    const { scope } = await table();
    const { rows } = await database.admin.query<{ name: string }>('SELECT current_database() AS name');
    const name = rows[0]?.name as string;
    await database.admin.query(`REVOKE TEMP ON DATABASE ${name} FROM PUBLIC`);
    try {
      const reader = database.pool('reader', 1);
      expect(await problemsOf(reader, scope)).toEqual([[SCOPE_PROBLEM.undetermined, null]]);
    } finally {
      await database.admin.query(`GRANT TEMP ON DATABASE ${name} TO PUBLIC`);
    }
  });

  /**
   * Класс «выданное соединение без обработчика 'error'»: pg-pool снимает свой
   * обработчик, пока соединение выдано, и обрыв сервером между запросами
   * проверки (`pg_terminate_backend`, `idle_session_timeout`) давал
   * необработанное 'error' — процесс падал. Окно делается детерминированным:
   * проверка держит первое соединение и ждёт второе (`canonicalFrom` из пула,
   * занятого тестом), и в этот момент первое соединение обрывается.
   */
  it('сервер оборвал выданное соединение между запросами — отказ undetermined, процесс жив, соединение не вернулось в пул', async () => {
    const { scope } = await table();
    const applicationName = `scope-ready-${counter}`;
    const probe = new Pool({
      connectionString: database.urls.app,
      max: 1,
      application_name: applicationName,
    });
    const reference = new Pool({ connectionString: database.urls.app, max: 1 });
    const blocker = await reference.connect();
    try {
      const checking = assertScopeReady(probe, scope, { canonicalFrom: reference }).then(
        () => null,
        (reason: unknown) => reason,
      );
      // Проверка дошла до второго соединения и ждёт его: первое выдано и без запроса.
      for (let i = 0; i < 100 && reference.waitingCount === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(reference.waitingCount).toBe(1);
      let terminated = 0;
      for (let i = 0; i < 100 && terminated === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const { rows } = await database.admin.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND state = 'idle'`,
          [applicationName],
        );
        for (const { pid } of rows) {
          await database.admin.query('SELECT pg_terminate_backend($1)', [pid]);
          terminated += 1;
        }
      }
      // Контроль фикстуры: оборвано ровно соединение проверки, пока оно выдано.
      expect(terminated).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      blocker.release();
      const error = await checking;
      expect(error).toBeInstanceOf(ScopeNotReadyError);
      expect((error as ScopeNotReadyError).problems.map((problem) => problem.code)).toContain(
        SCOPE_PROBLEM.undetermined,
      );
      // Оборванное соединение уничтожено, а не возвращено в пул.
      expect(probe.totalCount).toBe(0);
    } finally {
      await probe.end();
      await reference.end();
    }
  }, 30_000);

  it('обработчик обрыва снимается при возврате: соединение пула после проверок — без чужих обработчиков', async () => {
    const { scope } = await table();
    const probe = new Pool({ connectionString: database.urls.app, max: 1 });
    try {
      expect(await problemsOf(probe, scope)).toEqual('ready');
      expect(await problemsOf(probe, scope)).toEqual('ready');
      const client = await probe.connect();
      try {
        // Контроль: это то же соединение, через которое шли обе проверки.
        expect(probe.totalCount).toBe(1);
        expect(client.listenerCount('error')).toBe(0);
      } finally {
        client.release();
      }
    } finally {
      await probe.end();
    }
  });

  it('отказ перечисляет все причины сразу, текстом и кодами', async () => {
    const { name } = await table(() => 'SELECT 1');
    const error = await assertScopeReady(database.admin, scopeOf([name, 'absent'])).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ScopeNotReadyError);
    const problems = (error as ScopeNotReadyError).problems;
    expect(problems.map((problem) => problem.code).sort()).toEqual(
      [
        SCOPE_PROBLEM.bypassRls,
        SCOPE_PROBLEM.policyMissing,
        SCOPE_PROBLEM.rlsDisabled,
        SCOPE_PROBLEM.superuser,
        SCOPE_PROBLEM.tableMissing,
        SCOPE_PROBLEM.truncatePrivilege,
      ].sort(),
    );
    expect(Object.isFrozen(problems)).toBe(true);
    expect((error as Error).message).toContain(`[${SCOPE_PROBLEM.tableMissing}] absent:`);
  });
});
