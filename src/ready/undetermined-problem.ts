import { SCOPE_PROBLEM } from '../constants/scope-problem.constant';
import type { ScopeProblem } from '../types/scope-problem.type';

/** Проверка не выполнилась: причина отказа с текстом исходной ошибки. */
export function undeterminedProblem(table: string | null, stage: string, error: unknown): ScopeProblem {
  return {
    code: SCOPE_PROBLEM.undetermined,
    table,
    detail: `${stage}: ${error instanceof Error ? error.message : String(error)}`,
  };
}
