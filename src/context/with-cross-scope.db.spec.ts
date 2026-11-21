import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { CrossScopeRefusedError } from '../errors/cross-scope-refused.error';
import { ScopeConflictError } from '../errors/scope-conflict.error';
import { defineProjectScope } from '../scope/define-project-scope';
import { bodiesOf } from '../testing/bodies-of';
import { createScopeTables } from '../testing/create-scope-tables';
import { describeDb } from '../testing/describe-db';
import { PROJECT } from '../testing/project.constant';
import { rejectionOf } from '../testing/rejection-of';
import { createScopeTestDatabase } from '../testing/scope-test-database';
import type { ScopeTestDatabase } from '../testing/scope-test-database.type';
import type { ProjectScope } from '../types/project-scope.type';
import { withCrossScope } from './with-cross-scope';
import { withScope } from './with-scope';

const REASON = { reason: 'ночная очистка устаревших строк всех проектов' };

const bodies = async (client: PoolClient): Promise<string[]> => {
  const { rows } = await client.query<{ body: string }>('SELECT body FROM items ORDER BY body');
  return rows.map((row) => row.body);
};

describeDb('сквозной доступ — только отдельной ролью и с причиной [нужен PG_TEST_URL]', () => {
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

  it('под ролью сквозного доступа работа видит все области, причина — в параметре транзакции', async () => {
    const seen = await withCrossScope(database.maintenanceDb, scope, REASON, async (_tx, client) => {
      const { rows } = await client.query<{ reason: string }>('SELECT current_setting($1, true) AS reason', [
        scope.reasonSetting,
      ]);
      return { rows: await bodies(client), reason: rows[0]?.reason };
    });
    expect(seen).toEqual({ rows: ['a.1', 'a.2', 'b.1'], reason: REASON.reason });
    const { rows } = await database.maintenance.query<{ reason: string | null }>(
      'SELECT current_setting($1, true) AS reason',
      [scope.reasonSetting],
    );
    expect(rows[0]?.reason ?? '').toBe('');
  });

  it('роль приложения получает отказ ДО работы, а не пустое множество', async () => {
    let ran = false;
    const error = await rejectionOf(
      withCrossScope(database.appDb, scope, REASON, async () => {
        ran = true;
      }),
    );
    expect(error).toBeInstanceOf(CrossScopeRefusedError);
    expect(String(error)).toContain(`только под «${database.roles.maintenance}»`);
    expect(ran).toBe(false);
  });

  it('роль приложения не может стать ролью сквозного доступа через SET ROLE', async () => {
    const error = await rejectionOf(database.app.query(`SET ROLE ${database.roles.maintenance}`));
    expect((error as { code?: string }).code).toBe('42501');
  });

  it('двойник отказов по причине: перевод строки, табуляция и эмодзи — допустимы; ровно 10 видимых знаков — принято', async () => {
    for (const reason of ['чистка\nстарых строк', 'чистка\tстарых 🚀', '🚀'.repeat(10)]) {
      expect(await withCrossScope(database.maintenanceDb, scope, { reason }, async () => 'принято')).toBe(
        'принято',
      );
    }
  });

  it('без причины, с короткой причиной и у области без роли — отказ до запроса', async () => {
    let acquired = 0;
    const counted = (): void => {
      acquired += 1;
    };
    database.maintenance.on('acquire', counted);
    try {
      for (const why of [
        { reason: '' },
        { reason: '   x   ' },
        { reason: 'x'.repeat(1_001) },
        { reason: `${REASON.reason} \ud800` },
        // Невидимые знаки длины не дают: пробел нулевой ширины, заполнитель U+3164, BOM.
        { reason: '\u200b'.repeat(12) },
        { reason: `ab${'\u3164'.repeat(10)}` },
        { reason: `abc${'\ufeff'.repeat(10)}` },
        { reason: `ab${' '.repeat(10)}cd` },
        // Управляющий символ (ESC перекрасил бы вывод журнала аудита).
        { reason: `${REASON.reason} \u001b[2J` },
      ]) {
        expect(
          await rejectionOf(withCrossScope(database.maintenanceDb, scope, why, async () => 1)),
        ).toBeInstanceOf(CrossScopeRefusedError);
      }
      const withoutRole = defineProjectScope({
        setting: scope.setting,
        column: scope.column,
        columnType: scope.columnType,
        tables: [...scope.tables],
      });
      const error = await rejectionOf(
        withCrossScope(database.maintenanceDb, withoutRole, REASON, async () => 1),
      );
      expect(String(error)).toContain('нет maintenanceRole');
      expect(acquired).toBe(0);
    } finally {
      database.maintenance.off('acquire', counted);
    }
  });

  it('сквозной доступ и область не вкладываются друг в друга', async () => {
    const inScope = await rejectionOf(
      withScope(database.appDb, scope, PROJECT.a, () =>
        withCrossScope(database.maintenanceDb, scope, REASON, async (_tx, client) => bodies(client)),
      ),
    );
    expect(inScope).toBeInstanceOf(ScopeConflictError);
    const inCross = await rejectionOf(
      withCrossScope(database.maintenanceDb, scope, REASON, () =>
        withScope(database.appDb, scope, PROJECT.a, async (_tx, client) => bodies(client)),
      ),
    );
    expect(inCross).toBeInstanceOf(ScopeConflictError);
    expect(await bodiesOf(database.admin, 'items')).toEqual(['a.1', 'a.2', 'b.1']);
  });

  it('работа сквозного доступа, задавшая контекст области или подменившая причину, — ScopeConflictError и откат', async () => {
    for (const [setting, value] of [
      [scope.setting, PROJECT.a],
      [scope.reasonSetting, 'другая причина, не та, что передана'],
    ] as const) {
      const error = await rejectionOf(
        withCrossScope(database.maintenanceDb, scope, REASON, async (_tx, client) => {
          await client.query("INSERT INTO items (project_id, body) VALUES ($1, 'cross')", [PROJECT.b]);
          await client.query('SELECT set_config($1, $2, true)', [setting, value]);
        }),
      );
      expect([setting, error]).toEqual([setting, expect.any(ScopeConflictError)]);
    }
    expect(await bodiesOf(database.admin, 'items')).toEqual(['a.1', 'a.2', 'b.1']);
  });

  it('контекст области задан в сессии сквозного доступа до вызова — отказ ДО работы', async () => {
    const single = database.pool('maintenance', 1);
    await single.query(`SET app.project_id = '${PROJECT.a}'`);
    let ran = false;
    try {
      const error = await rejectionOf(
        withCrossScope(drizzle(single), scope, REASON, async () => {
          ran = true;
        }),
      );
      expect(error).toBeInstanceOf(CrossScopeRefusedError);
      expect(String(error)).toContain('сессионный SET');
      expect(ran).toBe(false);
    } finally {
      await single.query('RESET app.project_id');
    }
  });

  it('сессионная причина из работы сквозного доступа не достаётся следующему владельцу соединения', async () => {
    const single = database.pool('maintenance', 1);
    await withCrossScope(drizzle(single), scope, REASON, (_tx, client) =>
      client.query('SELECT set_config($1, $2, false)', [scope.reasonSetting, REASON.reason]),
    );
    const { rows } = await single.query<{ reason: string | null }>(
      'SELECT current_setting($1, true) AS reason',
      [scope.reasonSetting],
    );
    expect(rows[0]?.reason ?? '').toBe('');
  });
});
