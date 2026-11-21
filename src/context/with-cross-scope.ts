import {
  type PoolDatabase,
  type TransactionHandle,
  type TransactionOf,
  transactionKeepingFailure,
} from '@hoshinotatsuya/pg-runtime';
import type { PoolClient } from 'pg';

import { CROSS_SCOPE_LIMITS } from '../constants/cross-scope-limits.constant';
import { CrossScopeRefusedError } from '../errors/cross-scope-refused.error';
import { ScopeConflictError } from '../errors/scope-conflict.error';
import { visibleLength } from '../scope/visible-length';
import type { CrossScopeReason } from '../types/cross-scope-reason.type';
import type { ProjectScope } from '../types/project-scope.type';
import type { ScopeFrame } from '../types/scope-frame.type';
import type { ScopeTransactionOptions } from '../types/scope-transaction-options.type';
import { assertContextKept } from './assert-context-kept';
import { fencedWork } from './fenced-work';
import { scopeAppSettings } from './scope-app-settings';
import { SCOPE_FRAMES } from './scope-frames';
import { sessionReset } from './session-reset';
import { settingsWith } from './settings-with';

/**
 * Сквозной доступ ко всем областям — для обслуживающих задач (очистка,
 * миграция данных, отчёты по всем проектам). Не флаг в запросе: его даёт
 * только ОТДЕЛЬНАЯ роль (`maintenanceRole` области) со своей политикой, и база
 * обязана быть открыта под этой ролью. Роль приложения, вызвавшая функцию,
 * получает отказ ДО работы: её политика видела бы ноль строк, и задача
 * «отработала бы» молча на пустом множестве.
 *
 * Причина обязательна и уходит в параметр транзакции `scope.reasonSetting` —
 * триггер аудита читает её `current_setting(…, true)`. Внутри работы области
 * сквозной доступ — `ScopeConflictError`, и наоборот. К концу работы контекст
 * области обязан остаться пустым, а причина — той же (`assertContextKept`);
 * сессионные значения обоих параметров сбрасывает pg-runtime (`scopeAppSettings`).
 *
 * Политика роли сквозного доступа пропускает все строки только БЕЗ контекста
 * области: та же роль в `withScope` видит одну область.
 */
export async function withCrossScope<
  T,
  Db extends PoolDatabase = PoolDatabase,
  Tx extends TransactionHandle = TransactionOf<Db>,
>(
  db: Db,
  scope: ProjectScope,
  why: CrossScopeReason,
  work: (tx: Tx, client: PoolClient) => Promise<T>,
  options: ScopeTransactionOptions = {},
): Promise<T> {
  const role = scope.maintenanceRole;
  if (role === null) {
    throw new CrossScopeRefusedError(
      `withCrossScope: у области ${scope.setting} нет maintenanceRole — сквозного доступа нет`,
    );
  }
  const reason = typeof why?.reason === 'string' ? why.reason.trim() : '';
  // Нижний порог — по ВИДИМЫМ знакам (невидимые и пробелы подряд не считаются),
  // верхний — по длине параметра. Управляющие (кроме табуляции и переводов
  // строки) — отказ: причину читает триггер аудита и показывают людям.
  if (
    visibleLength(reason) < CROSS_SCOPE_LIMITS.MIN_REASON_LENGTH ||
    reason.length > CROSS_SCOPE_LIMITS.MAX_REASON_LENGTH ||
    /\p{Cc}/u.test(reason.replace(/[\t\n\r]/g, '')) ||
    /\p{Cs}/u.test(reason)
  ) {
    throw new CrossScopeRefusedError(
      `withCrossScope: причина — от ${CROSS_SCOPE_LIMITS.MIN_REASON_LENGTH} видимых знаков до ${CROSS_SCOPE_LIMITS.MAX_REASON_LENGTH} символов без управляющих символов (NUL, ESC…) и одиночных суррогатов UTF-16`,
    );
  }
  const frames = (SCOPE_FRAMES.getStore() ?? []).filter((frame) => frame.active);
  if (frames.length > 0) {
    throw new ScopeConflictError(
      `withCrossScope внутри работы ${frames.map((frame) => `${frame.setting}=${frame.value ?? '*'}`).join(', ')}: сквозной доступ не вкладывается`,
    );
  }
  const localSettings = settingsWith('withCrossScope', scope, options, scope.reasonSetting, reason);
  const frame: ScopeFrame = { pool: db.$client, setting: scope.setting, value: null, active: true };
  try {
    return await SCOPE_FRAMES.run([frame], () =>
      transactionKeepingFailure<T, Db, Tx>(
        db,
        async (tx, client) => {
          const { rows } = await client.query<{ role: string; context: string | null }>(
            'SELECT current_user::text AS role, current_setting($1, true) AS context',
            [scope.setting],
          );
          if (rows[0]?.role !== role) {
            throw new CrossScopeRefusedError(
              `withCrossScope: сессия под ролью «${rows[0]?.role ?? '?'}», а сквозной доступ — только под «${role}»`,
            );
          }
          if ((rows[0]?.context ?? '') !== '') {
            throw new CrossScopeRefusedError(
              `withCrossScope: в сессии уже задан контекст ${scope.setting} — сессионный SET не убран`,
            );
          }
          return fencedWork(
            client,
            () => work(tx, client),
            (query) => assertContextKept(query, scope, { value: null, reason }),
          );
        },
        {
          ...options,
          ...sessionReset('withCrossScope', options),
          localSettings,
          resetAppSettings: scopeAppSettings(scope, options),
        },
      ),
    );
  } finally {
    frame.active = false;
  }
}
