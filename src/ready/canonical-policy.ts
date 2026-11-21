import type { PoolClient } from 'pg';

import { isolationPolicySql } from '../policy/isolation-policy-sql';
import { maintenancePolicySql } from '../policy/maintenance-policy-sql';
import { quoteIdentifier } from '../scope/quote-identifier';
import type { CanonicalPolicy } from '../types/canonical-policy.type';
import type { ProjectScope } from '../types/project-scope.type';

/**
 * Эталон выражений политик — от САМОГО сервера: те же политики создаются на
 * временной таблице в откатываемой транзакции, и `pg_get_expr` печатает их так
 * же, как политики настоящей таблицы. Сравнивать с текстом из пакета нельзя:
 * сервер переписывает выражение (приведения, скобки), и сравнение строк
 * зависело бы от версии Postgres.
 *
 * Транзакция — `READ WRITE` явно: пул с `default_transaction_read_only = on`
 * (роль или база только для чтения) эталон строит. Реплика в восстановлении
 * не пишет вовсе — для неё эталон берётся с пула основного (`canonicalFrom`).
 * Нужно право TEMP на базу (по умолчанию у PUBLIC). Не вышло — исключение, и
 * вызывающий превращает его в отказ «не смог определить». Соединение, на
 * котором откат не прошёл, помечается `broken`: в пул его не возвращают.
 */
export async function canonicalPolicy(
  client: PoolClient,
  scope: ProjectScope,
): Promise<{
  readonly canonical: CanonicalPolicy | undefined;
  readonly error: unknown;
  readonly broken: Error | undefined;
}> {
  const probe = quoteIdentifier('pg_temp.project_scope_ready_probe');
  let canonical: CanonicalPolicy | undefined;
  let failure: unknown;
  let broken: Error | undefined;
  try {
    await client.query('BEGIN READ WRITE');
    await client.query(
      `CREATE TEMP TABLE ${probe} (${quoteIdentifier(scope.column)} ${scope.columnType}) ON COMMIT DROP`,
    );
    await client.query(isolationPolicySql(scope, probe));
    await client.query(maintenancePolicySql(scope, probe, 'PUBLIC'));
    const { rows } = await client.query<{ name: string; qual: string | null; with_check: string | null }>(
      `SELECT polname::text AS name, pg_get_expr(polqual, polrelid) AS qual, pg_get_expr(polwithcheck, polrelid) AS with_check
         FROM pg_policy WHERE polrelid = 'pg_temp.project_scope_ready_probe'::regclass`,
    );
    const own = rows.find((row) => row.name === scope.policyName);
    const maintenance = rows.find((row) => row.name === scope.maintenancePolicyName);
    if (
      rows.length !== 2 ||
      typeof own?.qual !== 'string' ||
      typeof own.with_check !== 'string' ||
      typeof maintenance?.qual !== 'string' ||
      typeof maintenance.with_check !== 'string'
    ) {
      throw new Error(
        `эталонные политики прочитались не двумя строками с обоими выражениями (${rows.length})`,
      );
    }
    canonical = {
      qual: own.qual,
      withCheck: own.with_check,
      maintenanceQual: maintenance.qual,
      maintenanceWithCheck: maintenance.with_check,
    };
  } catch (error) {
    failure = error;
  } finally {
    await client.query('ROLLBACK').catch((error: unknown) => {
      broken = error instanceof Error ? error : new Error(String(error));
    });
  }
  return { canonical, error: failure, broken };
}
