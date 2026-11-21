import {
  NESTED_TRANSACTION,
  type PoolDatabase,
  type TransactionHandle,
  type TransactionOf,
  transactionKeepingFailure,
} from '@hoshinotatsuya/pg-runtime';
import type { PoolClient } from 'pg';

import { ScopeConflictError } from '../errors/scope-conflict.error';
import type { ProjectScope } from '../types/project-scope.type';
import type { ScopeColumnType } from '../types/scope-column-type.type';
import type { ScopeFrame } from '../types/scope-frame.type';
import type { ScopeId } from '../types/scope-id.type';
import type { ScopeTransactionOptions } from '../types/scope-transaction-options.type';
import { assertContextKept } from './assert-context-kept';
import { fencedWork } from './fenced-work';
import { scopeAppSettings } from './scope-app-settings';
import { SCOPE_FRAMES } from './scope-frames';
import { scopeIdText } from './scope-id-text';
import { sessionReset } from './session-reset';
import { settingsWith } from './settings-with';

/**
 * Работа в транзакции, несущей значение области: политики RLS таблиц области
 * пропускают только её строки — и запрос, в котором забыт `WHERE project_id`,
 * чужих строк не увидит и не запишет.
 *
 * Значение задаётся на ТРАНЗАКЦИЮ (`set_config(…, true)` = `SET LOCAL`, тем же
 * запросом, что таймауты pg-runtime): сессионный `SET` остался бы на
 * соединении пула и достался бы следующему владельцу, а под пулером в
 * transaction mode — чужому клиенту.
 *
 * Вложенный вызов: та же область на том же пуле — точка сохранения во внешней
 * транзакции; та же область на ДРУГОМ пуле — своя транзакция на своём
 * соединении; ДРУГОЕ значение той же области (на любом пуле), другая область на
 * том же пуле или вызов внутри сквозного доступа — `ScopeConflictError`.
 *
 * К концу работы (до COMMIT) контекст обязан остаться тем же, а причины
 * сквозного доступа — не быть (`assertContextKept`); сессионные значения обоих
 * параметров сбрасывает pg-runtime (`scopeAppSettings`). Запросы, отложенные
 * работой, после её возврата — отказ (`fencedWork`). После транзакции
 * соединение чистится целиком (`resetSession` pg-runtime: временные таблицы,
 * курсоры WITH HOLD, параметры сессии) — кроме пулера в transaction mode, где
 * чистить нечего и нельзя (см. `sessionReset`).
 *
 * Что значение области принадлежит пользователю запроса, проверяет вызывающий:
 * RLS отделяет области друг от друга, но не знает, кто их просит. Значения
 * области в тексты отказов не попадают: они уходят в логи.
 */
export async function withScope<
  T,
  Db extends PoolDatabase = PoolDatabase,
  Tx extends TransactionHandle = TransactionOf<Db>,
  C extends ScopeColumnType = ScopeColumnType,
>(
  db: Db,
  scope: ProjectScope<C>,
  scopeId: ScopeId<C>,
  work: (tx: Tx, client: PoolClient) => Promise<T>,
  options: ScopeTransactionOptions = {},
): Promise<T> {
  const value = scopeIdText(scope, scopeId);
  const pool = db.$client;
  const frames = (SCOPE_FRAMES.getStore() ?? []).filter((frame) => frame.active);
  const conflicting = frames.find(
    (frame) => frame.value === null || (frame.setting === scope.setting && frame.value !== value),
  );
  if (conflicting !== undefined) {
    throw new ScopeConflictError(
      conflicting.value === null
        ? `withScope внутри сквозного доступа ${conflicting.setting}: область и сквозной доступ не смешиваются`
        : `withScope(${scope.setting}) с другим значением внутри работы ${conflicting.setting}: одна цепочка вызовов — одна область`,
    );
  }
  const checked = (tx: Tx, client: PoolClient): Promise<T> =>
    fencedWork(
      client,
      () => work(tx, client),
      (query) => assertContextKept(query, scope, { value, reason: null }),
    );
  const outer = frames.find((frame) => frame.pool === pool);
  if (outer !== undefined) {
    if (outer.setting !== scope.setting) {
      throw new ScopeConflictError(
        `withScope(${scope.setting}) внутри транзакции области ${outer.setting} на том же пуле: две области в одной транзакции`,
      );
    }
    // Та же область на том же пуле: значение уже задано во внешней транзакции.
    // Запрет смены роли и параметров области — и здесь: `set_config(…, true)`
    // точки сохранения переживает RELEASE, и роль, сменённая вложенной работой,
    // осталась бы до конца внешней. Сейчас localSettings под точкой сохранения
    // отвергает и pg-runtime, но запрет этой функции не должен держаться на нём.
    settingsWith('withScope', scope, options, scope.setting, value);
    return transactionKeepingFailure<T, Db, Tx>(db, checked, {
      ...options,
      nested: NESTED_TRANSACTION.savepoint,
    });
  }
  const localSettings = settingsWith('withScope', scope, options, scope.setting, value);
  const frame: ScopeFrame = { pool, setting: scope.setting, value, active: true };
  try {
    return await SCOPE_FRAMES.run([...frames, frame], () =>
      transactionKeepingFailure<T, Db, Tx>(db, checked, {
        ...options,
        ...sessionReset('withScope', options),
        localSettings,
        resetAppSettings: scopeAppSettings(scope, options),
      }),
    );
  } finally {
    frame.active = false;
  }
}
