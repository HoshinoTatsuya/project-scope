import type { PoolClient } from 'pg';

import { SCOPE_PROBLEM } from '../constants/scope-problem.constant';
import type { ProjectScope } from '../types/project-scope.type';
import type { ScopeProblem } from '../types/scope-problem.type';
import { ownerRightsFacts } from './owner-rights-facts';

/**
 * Пути мимо политик области, которых нет в таблицах: функции с правами
 * владельца, параметр области в определении функции, LEAKPROOF, сопоставления
 * пользователей внешних серверов (`ownerRightsFacts`).
 */
export async function ownerRightsProblems(client: PoolClient, scope: ProjectScope): Promise<ScopeProblem[]> {
  const problems: ScopeProblem[] = [];
  for (const facts of await ownerRightsFacts(client, scope)) {
    const add = (code: ScopeProblem['code'], detail: string): void => {
      problems.push({ code, table: null, detail });
    };
    if (facts.kind === 'mapping') {
      add(
        SCOPE_PROBLEM.userMapping,
        `сопоставление пользователя ${facts.owner} на внешнем сервере ${facts.name}: внешние таблицы этого сервера читают данные под ролью сопоставления, а не под политиками сессии (DROP USER MAPPING или сопоставление только для роли сквозного доступа)`,
      );
      continue;
    }
    const reached = `функция ${facts.name} (сессия до неё дотягивается: ${facts.paths.join(', ')})`;
    if (facts.definer) {
      add(
        SCOPE_PROBLEM.securityDefiner,
        `${reached} — SECURITY DEFINER, владелец «${facts.owner}» обходит политики области (суперпользователь, BYPASSRLS, член такой роли или роли сквозного доступа): тело видит и меняет строки всех областей — владельцем сделайте роль без обхода RLS или отзовите EXECUTE`,
      );
    }
    if (facts.sets_scope) {
      add(
        SCOPE_PROBLEM.routineSetsScope,
        `${reached} задаёт ${scope.setting} или ${scope.reasonSetting} в своём определении (SET …): внутри неё запросы видят другую область, а сверка контекста к концу работы этого не видит`,
      );
    }
    if (facts.leakproof) {
      add(
        SCOPE_PROBLEM.leakproofFunction,
        `${reached} объявлена LEAKPROOF: планировщик вычисляет её условие до политик, на строках всех областей, и ошибка или notice выносят чужие значения`,
      );
    }
  }
  return problems;
}
