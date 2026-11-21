import { deepFreeze } from '../deep-freeze';

export const SCOPE_READY_LIMITS = {
  /** Потолок проверки по умолчанию: старт не висит на занятом пуле или блокировке каталога. */
  DEFAULT_TIMEOUT_MS: 30_000,
  /** Наибольший потолок: таймер Node дольше 2^31−1 мс срабатывает сразу. */
  MAX_TIMEOUT_MS: 2_147_483_647,
} as const;

deepFreeze(SCOPE_READY_LIMITS);
