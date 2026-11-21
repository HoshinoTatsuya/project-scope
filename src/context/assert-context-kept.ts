import type { PoolClient } from 'pg';

import { SQL_STATE } from '../constants/sql-state.constant';
import { ScopeConflictError } from '../errors/scope-conflict.error';
import type { ExpectedContext } from '../types/expected-context.type';
import type { ProjectScope } from '../types/project-scope.type';

/**
 * Конец работы, ДО COMMIT: параметры области те же, что задала функция. Работа,
 * сменившая контекст (`set_config(…, true)` во вложенной работе переживает
 * RELEASE точки сохранения), задавшая причину сквозного доступа (её читает
 * триггер аудита) или сессионный `SET` другой области, получает
 * `ScopeConflictError` — и транзакция откатывается вместе со своими `SET`.
 *
 * Сессионные значения обоих параметров проверка не трогает: их сбрасывает
 * pg-runtime после работы, до COMMIT (`resetAppSettings` самой внешней
 * транзакции области, `scopeAppSettings`). Иначе `set_config(…, false)` из
 * работы остался бы на соединении пула, и следующий владелец соединения (под
 * пулером в transaction mode — сосед) «без контекста» видел бы эту область.
 */
export async function assertContextKept(
  query: PoolClient['query'],
  scope: ProjectScope,
  expected: ExpectedContext,
): Promise<void> {
  let row: { context: string | null; reason: string | null } | undefined;
  try {
    const { rows } = await query<{ context: string | null; reason: string | null }>(
      'SELECT current_setting($1, true) AS context, current_setting($2, true) AS reason',
      [scope.setting, scope.reasonSetting],
    );
    row = rows[0];
  } catch (error) {
    // Работа поймала ошибку запроса и вернула успех: COMMIT станет откатом, проверять нечего.
    if ((error as { code?: unknown }).code === SQL_STATE.inFailedTransaction) {
      return;
    }
    throw error;
  }
  const context = row?.context ?? '';
  const reason = row?.reason ?? '';
  if (context !== (expected.value ?? '')) {
    throw new ScopeConflictError(
      `контекст ${scope.setting} сменён внутри работы ${expected.value === null ? 'сквозного доступа' : 'области'}: ` +
        'одна транзакция — одна область, смена контекста откатывается',
    );
  }
  if (reason !== (expected.reason ?? '')) {
    throw new ScopeConflictError(
      `${scope.reasonSetting} задан внутри работы ${expected.reason === null ? 'области: причину сквозного доступа задаёт только withCrossScope' : 'сквозного доступа: причина подменена'}`,
    );
  }
}
