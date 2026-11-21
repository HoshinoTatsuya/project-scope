import type { Pool, PoolClient } from 'pg';

import type { CanonicalPolicy } from '../types/canonical-policy.type';
import type { ProjectScope } from '../types/project-scope.type';
import type { ScopeProblem } from '../types/scope-problem.type';
import type { ScopeReadyOptions } from '../types/scope-ready-options.type';
import { canonicalPolicy } from './canonical-policy';
import { catalogProblems } from './catalog-problems';
import { ownerRightsProblems } from './owner-rights-problems';
import { roleProblems } from './role-problems';
import { undeterminedProblem } from './undetermined-problem';

/**
 * Причины проверки на одном соединении пула (`acquire`/`release` — от
 * `assertScopeReady`, который держит потолок времени): роли сессии вне
 * транзакции, эталон политик, проход по каталогу, код с правами владельца и
 * сопоставления пользователей (`ownerRightsProblems`). Каждый шаг, который не
 * выполнился, — `undetermined`, остальные шаги всё равно идут.
 */
export async function collectProblems(
  pool: Pool,
  scope: ProjectScope,
  options: ScopeReadyOptions,
  acquire: (from: Pool) => Promise<PoolClient>,
  release: (client: PoolClient, broken?: Error) => void,
): Promise<ScopeProblem[]> {
  const problems: ScopeProblem[] = [];
  let client: PoolClient;
  try {
    client = await acquire(pool);
  } catch (error) {
    return [undeterminedProblem(null, 'соединение пула', error)];
  }
  let broken: Error | undefined;
  try {
    try {
      problems.push(...(await roleProblems(client, scope)));
    } catch (error) {
      problems.push(undeterminedProblem(null, 'роль и сессия', error));
    }
    let canonical: CanonicalPolicy | undefined;
    let reference: PoolClient | undefined = client;
    // Тот же пул — то же соединение: второе ждало бы освобождения первого (пул из одного соединения).
    if (options.canonicalFrom !== undefined && options.canonicalFrom !== pool) {
      try {
        reference = await acquire(options.canonicalFrom);
      } catch (error) {
        reference = undefined;
        problems.push(undeterminedProblem(null, 'соединение canonicalFrom', error));
      }
    }
    if (reference !== undefined) {
      const built = await canonicalPolicy(reference, scope);
      if (built.canonical === undefined) {
        problems.push(
          undeterminedProblem(
            null,
            'эталон политики (нужно право TEMP на базу и запись; для реплики — canonicalFrom)',
            built.error,
          ),
        );
      }
      canonical = built.canonical;
      if (reference === client) {
        broken = built.broken;
      } else {
        release(reference, built.broken);
      }
    }
    if (broken === undefined) {
      try {
        problems.push(...(await catalogProblems(client, scope, canonical)));
      } catch (error) {
        problems.push(undeterminedProblem(null, 'каталог', error));
      }
      try {
        problems.push(...(await ownerRightsProblems(client, scope)));
      } catch (error) {
        problems.push(
          undeterminedProblem(null, 'функции с правами владельца и сопоставления пользователей', error),
        );
      }
    } else {
      problems.push(undeterminedProblem(null, 'каталог', broken));
    }
  } finally {
    release(client, broken);
  }
  return problems;
}
