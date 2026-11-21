import { deepFreeze } from '../deep-freeze';

/** Границы причины сквозного доступа: «x» — не причина, роман — не параметр транзакции. */
export const CROSS_SCOPE_LIMITS = {
  MIN_REASON_LENGTH: 10,
  MAX_REASON_LENGTH: 1_000,
} as const;

deepFreeze(CROSS_SCOPE_LIMITS);
