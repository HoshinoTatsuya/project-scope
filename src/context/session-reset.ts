import type { ScopeTransactionOptions } from '../types/scope-transaction-options.type';

/**
 * Уборка соединения после транзакции области: `resetSession` pg-runtime
 * (`DISCARD TEMP`, `CLOSE ALL`, `RESET ALL`…, затем — восстановление базовой
 * линии). Временная таблица, курсор WITH HOLD или параметр сессии из работы
 * области A иначе достались бы следующему владельцу соединения — работе
 * области B.
 *
 * `sessionBaseline` пакет не задаёт: по умолчанию (pg-runtime ≥ 0.7.0,
 * `connect`) соединение возвращается к состоянию, в котором пришло в первую
 * транзакцию с уборкой, — параметры `pool.on('connect')` остаются; `defaults`
 * от вызывающего проходит как есть. Изоляцию держит снятие состояния работы,
 * одинаковое при обеих базовых линиях; свои параметры (`app.*`, в том числе
 * параметры области) в базовую линию не попадают — Postgres их не показывает.
 *
 * Без пулера — всегда; `resetSession: false` — отказ: выключить уборку значит
 * отдать состояние одной области другой. Под пулером в transaction mode уборка
 * после COMMIT ушла бы на чужое серверное соединение (pg-runtime отказывает) —
 * там сессионные команды работы отсекает сам pg-runtime, а временные таблицы
 * обязаны быть `ON COMMIT DROP` (ограничение названо в README).
 */
export function sessionReset(
  caller: string,
  options: ScopeTransactionOptions,
): Pick<ScopeTransactionOptions, 'resetSession'> {
  if (options.transactionPooler === true) {
    return {};
  }
  // Типы `false` не пропускают; вызов из JS или через приведение типов — отказ здесь.
  if ((options.resetSession as boolean | undefined) === false) {
    throw new Error(
      `${caller}: resetSession: false — состояние сессии (временные таблицы, курсоры) из работы одной области досталось бы другой`,
    );
  }
  return { resetSession: true };
}
