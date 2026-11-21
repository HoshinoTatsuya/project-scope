import type { PoolClient } from 'pg';

import { SCOPE_PROBLEM } from '../constants/scope-problem.constant';
import { splitTableName } from '../scope/split-table-name';
import type { CanonicalPolicy } from '../types/canonical-policy.type';
import type { ProjectScope } from '../types/project-scope.type';
import type { ScopeProblem } from '../types/scope-problem.type';
import { foreignKeyFacts } from './foreign-key-facts';
import { isSecurityInvoker } from './is-security-invoker';
import { policyFacts } from './policy-facts';
import { protectedRelationProblems } from './protected-relation-problems';
import { ruleFacts } from './rule-facts';
import { scopeRelations } from './scope-relations';
import { sharedCascadeFacts } from './shared-cascade-facts';

/**
 * Изоляция зависит от ВСЕХ отношений и связей с данными области, а не от
 * списка: судится один проход по каталогу (`scopeRelations`).
 * - таблица списка, её секция и наследник — защита (`protectedRelationProblems`);
 * - таблица с колонкой области вне списка — `unlisted-table`;
 * - материализованное представление над данными области — `materialized-view`;
 * - представление без `security_invoker` — `view-not-invoker`;
 * - внешний ключ на защищённую таблицу без пары колонок области или каскад из
 *   общей таблицы, которую роль сессии может менять, — `foreign-key-across-scopes`;
 * - доступный предок по наследованию без колонки области — `inheritance-ancestor`;
 * - правило на данных области — `rewrite-rule`.
 * Отношения вне защиты не судятся, только если ДОКАЗАНО, что они недоступны:
 * ни у одной роли, в которую сессия может войти, нет ни одного права на
 * таблицу или её колонки. Представление без `security_invoker` допустимо, если
 * его владелец — сама роль сессии: тогда оно проходит её же политики.
 */
export async function catalogProblems(
  client: PoolClient,
  scope: ProjectScope,
  canonical: CanonicalPolicy | undefined,
): Promise<ScopeProblem[]> {
  const relations = await scopeRelations(client, scope);
  const problems: ScopeProblem[] = [];
  for (const table of scope.tables) {
    if (!relations.some((relation) => relation.listed === table)) {
      const { schema, name } = splitTableName(table);
      problems.push({ code: SCOPE_PROBLEM.tableMissing, table, detail: `таблицы ${schema}.${name} нет` });
    }
  }
  const guarded = relations.filter((relation) => relation.listed !== null || relation.root !== null);
  const policies = await policyFacts(
    client,
    guarded.map((relation) => relation.oid),
  );
  for (const relation of relations) {
    const label =
      relation.listed ?? (relation.root === null ? relation.display : `${relation.root}/${relation.display}`);
    if (relation.listed !== null || relation.root !== null) {
      problems.push(
        ...protectedRelationProblems(
          scope,
          label,
          relation,
          policies.filter((policy) => policy.relation === relation.oid),
          canonical,
        ),
      );
      continue;
    }
    if (relation.accessible !== true) {
      continue;
    }
    if (relation.ancestor === true && relation.column_type === null) {
      problems.push({
        code: SCOPE_PROBLEM.inheritanceAncestor,
        table: label,
        detail:
          'предок по наследованию таблицы области без колонки области: запрос к нему читает и меняет строки наследников всех областей, TRUNCATE стирает их — отзовите права (REVOKE ALL) или снимите наследование (NO INHERIT)',
      });
    } else if (relation.kind === 'm') {
      problems.push({
        code: SCOPE_PROBLEM.materializedView,
        table: label,
        detail:
          'материализованное представление над данными области: у него нет RLS, REFRESH сохраняет строки, видимые обновившему, и их видят все',
      });
    } else if (relation.kind === 'v') {
      // Представление роли сессии проходит её же политики (FORCE и роли проверены выше).
      if (!isSecurityInvoker(relation.invoker) && relation.session_owned !== true) {
        problems.push({
          code: SCOPE_PROBLEM.viewNotInvoker,
          table: label,
          detail:
            'представление над данными области без security_invoker = true, владелец — не роль сессии: политики применяются к его владельцу, а не к вызывающему',
        });
      }
    } else {
      problems.push({
        code: SCOPE_PROBLEM.unlistedTable,
        table: label,
        detail: `колонка ${scope.column} есть, а таблицы нет в списке области (и она не секция и не наследник таблицы списка): её строки не изолированы`,
      });
    }
  }
  for (const key of await foreignKeyFacts(
    client,
    scope.column,
    guarded.map((relation) => relation.oid),
  )) {
    if (key.paired !== true) {
      problems.push({
        code: SCOPE_PROBLEM.foreignKeyAcrossScopes,
        table: key.child,
        detail:
          `внешний ключ ${key.name} → ${key.parent} без пары колонок ${scope.column}: проверка ключа и каскады идут мимо RLS ` +
          `(другая область меняет и удаляет строки, вставка отвечает, есть ли чужая строка) — ключ (${scope.column}, …) REFERENCES (${scope.column}, …)`,
      });
    }
  }
  for (const key of await sharedCascadeFacts(
    client,
    guarded.map((relation) => relation.oid),
  )) {
    problems.push({
      code: SCOPE_PROBLEM.foreignKeyAcrossScopes,
      table: key.child,
      detail:
        `внешний ключ ${key.name} → общая таблица ${key.parent} с каскадом (${key.actions.join(', ')}), а роль сессии может менять ${key.parent}: ` +
        'удаление общей строки из работы одной области меняет строки всех — меняйте общую таблицу ролью сквозного доступа (REVOKE у роли приложения) или уберите каскад',
    });
  }
  for (const rule of await ruleFacts(
    client,
    relations.map((relation) => relation.oid),
  )) {
    problems.push({
      code: SCOPE_PROBLEM.rewriteRule,
      table: rule.relation,
      detail: `правило ${rule.name} касается данных области: его действие исполняется правами владельца таблицы правила — замените триггером`,
    });
  }
  return problems;
}
