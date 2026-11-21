import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import {
  assertScopeReady,
  defineProjectScope,
  SCOPE_COLUMN_TYPE,
  type ScopeColumnType,
  type ScopeReadyOptions,
  withCrossScope,
  withScope,
} from '../../index';

/**
 * Договор типов публичного API (компилируется спекой `type-contract.spec.ts`
 * и `pnpm typecheck`): строки `@ts-expect-error` — то, что типы обязаны
 * отвергать; без ошибки на такой строке компилятор сам отвечает TS2578.
 */
export async function contract(pool: Pool, anyColumnType: ScopeColumnType): Promise<void> {
  const db = drizzle(pool);
  const uuidScope = defineProjectScope({
    setting: 'app.project_id',
    column: 'project_id',
    columnType: SCOPE_COLUMN_TYPE.uuid,
    tables: ['items'],
  });
  const bigintScope = defineProjectScope({
    setting: 'app.tenant_id',
    column: 'tenant_id',
    columnType: 'bigint',
    tables: ['items'],
  });
  const wideScope = defineProjectScope({
    setting: 'app.org_id',
    column: 'org_id',
    columnType: anyColumnType,
    tables: ['items'],
  });
  await withScope(db, uuidScope, '0a0a0a0a-0000-4000-8000-00000000000a', async () => 1);
  // @ts-expect-error — число для uuid-области отвергают типы, а не только рантайм
  await withScope(db, uuidScope, 42, async () => 1);
  await withScope(db, bigintScope, 42n, async () => 1);
  await withScope(db, bigintScope, 42, async () => 1);
  // Тип колонки известен лишь объединением — проверка за рантаймом.
  await withScope(db, wideScope, 42, async () => 1);
  // @ts-expect-error — resetSession: false отвергают типы
  await withScope(db, uuidScope, 'x', async () => 1, { resetSession: false });
  await withScope(db, uuidScope, 'x', async () => 1, { resetSession: true, statementTimeoutMs: 1000 });
  // @ts-expect-error — nested решает область, а не вызывающий
  await withScope(db, uuidScope, 'x', async () => 1, { nested: 'savepoint' });
  await withCrossScope(db, uuidScope, { reason: 'ночная очистка старых документов' }, async () => 1, {
    // @ts-expect-error — resetSession: false отвергают типы и у сквозного доступа
    resetSession: false,
  });
  const options: ScopeReadyOptions = { timeoutMs: 1000, canonicalFrom: pool };
  await assertScopeReady(pool, uuidScope, options);
}
