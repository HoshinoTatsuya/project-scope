import { deepFreeze } from '../deep-freeze';

export const MIGRATION_SCOPE_LIMITS = {
  /** Наименьшая длина причины допущения: «legacy» не объясняет ничего. */
  MIN_REASON_LENGTH: 20,
} as const;

deepFreeze(MIGRATION_SCOPE_LIMITS);
