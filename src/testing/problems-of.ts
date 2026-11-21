import type { Pool } from 'pg';

import { ScopeNotReadyError } from '../errors/scope-not-ready.error';
import { assertScopeReady } from '../ready/assert-scope-ready';
import type { ProjectScope } from '../types/project-scope.type';
import type { ScopeReadyOptions } from '../types/scope-ready-options.type';

/**
 * Ответ `assertScopeReady`: `'ready'` — проверка ЗАВЕРШИЛАСЬ успехом; иначе
 * причины парами [код, таблица], по порядку. Отказ с пустым перечнем — сам по
 * себе ошибка: «отказал, не назвав причин» не должен читаться как «готово».
 */
export const problemsOf = async (
  pool: Pool,
  scope: ProjectScope,
  options?: ScopeReadyOptions,
): Promise<'ready' | [string, string | null][]> => {
  try {
    await assertScopeReady(pool, scope, options);
    return 'ready';
  } catch (error) {
    if (!(error instanceof ScopeNotReadyError)) {
      throw error;
    }
    if (error.problems.length === 0) {
      throw new Error('ScopeNotReadyError без причин');
    }
    return error.problems.map((problem): [string, string | null] => [problem.code, problem.table]).sort();
  }
};
