import type { TransactionOptions } from '@hoshinotatsuya/pg-runtime';

/**
 * Опции транзакции pg-runtime, кроме `nested`: вложенность решает область
 * (та же область на том же пуле — точка сохранения, другая — отказ).
 * `localSettings` с параметром области — отказ: значение области задаёт только
 * аргумент `scopeId`. `resetSession` — только `true`: выключить уборку
 * соединения значит отдать состояние одной области другой (`false` отвергают
 * типы и рантайм).
 */
export type ScopeTransactionOptions = Omit<TransactionOptions, 'nested' | 'resetSession'> & {
  readonly resetSession?: true;
};
