import type { ScopeProblemCode } from './scope-problem-code.type';

/** Одна причина, по которой изоляция области не готова. */
export interface ScopeProblem {
  readonly code: ScopeProblemCode;
  /** Таблица (или `таблица/секция`), к которой относится причина; null — к роли или сессии. */
  readonly table: string | null;
  readonly detail: string;
}
