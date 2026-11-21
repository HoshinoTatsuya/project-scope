import { SCOPE_COLUMN_REGTYPE } from '../constants/scope-column-regtype.constant';
import { SCOPE_PROBLEM } from '../constants/scope-problem.constant';
import type { CanonicalPolicy } from '../types/canonical-policy.type';
import type { PolicyFacts } from '../types/policy-facts.type';
import type { ProjectScope } from '../types/project-scope.type';
import type { RelationFacts } from '../types/relation-facts.type';
import type { ScopeProblem } from '../types/scope-problem.type';

/**
 * Причины таблицы списка, её секции или наследника: таблица (не представление),
 * колонка области объявленного типа и с детерминированной колацией, RLS и
 * FORCE, политика изоляции совпадает с эталоном, политика сквозного доступа
 * (если есть) — тоже и только на свою роль, других разрешающих политик на
 * роль сессии нет (кроме тех, что не открывают ничего: `USING (false)`,
 * `WITH CHECK (false)`), права TRUNCATE у роли сессии нет.
 *
 * `canonical` — undefined, если эталон построить не удалось (это уже отказ
 * `undetermined`): тогда выражения не сравниваются, остальное проверяется.
 */
export function protectedRelationProblems(
  scope: ProjectScope,
  label: string,
  facts: RelationFacts,
  policies: readonly PolicyFacts[],
  canonical: CanonicalPolicy | undefined,
): ScopeProblem[] {
  const problems: ScopeProblem[] = [];
  const add = (code: ScopeProblem['code'], detail: string): void => {
    problems.push({ code, table: label, detail });
  };
  if (facts.kind !== 'r' && facts.kind !== 'p') {
    add(SCOPE_PROBLEM.tableMissing, `это не таблица (relkind ${facts.kind}): RLS к нему не применяется`);
    return problems;
  }
  if (facts.column_type !== SCOPE_COLUMN_REGTYPE[scope.columnType]) {
    add(
      SCOPE_PROBLEM.columnMismatch,
      facts.column_type === null
        ? `нет колонки ${scope.column}`
        : `колонка ${scope.column} типа ${facts.column_type}, объявлен ${scope.columnType}`,
    );
  }
  if (facts.deterministic === false) {
    add(
      SCOPE_PROBLEM.nondeterministicCollation,
      `колонка ${scope.column} с недетерминированной колацией: значения, разные для приложения, равны для политики`,
    );
  }
  if (facts.rls !== true) {
    add(SCOPE_PROBLEM.rlsDisabled, 'ROW LEVEL SECURITY выключен');
  } else if (facts.forced !== true) {
    add(
      facts.owned === true ? SCOPE_PROBLEM.ownerWithoutForce : SCOPE_PROBLEM.rlsNotForced,
      facts.owned === true
        ? 'роль сессии — владелец таблицы, а FORCE ROW LEVEL SECURITY нет: политики к ней не применяются'
        : 'нет FORCE ROW LEVEL SECURITY: владелец таблицы политики не проходит',
    );
  }
  const expression = (
    policy: PolicyFacts,
    qual: string | undefined,
    withCheck: string | undefined,
  ): string[] => [
    ...(qual === undefined || policy.qual === qual ? [] : [`USING ${String(policy.qual)} ≠ ${qual}`]),
    ...(withCheck === undefined || policy.with_check === withCheck
      ? []
      : [`WITH CHECK ${String(policy.with_check)} ≠ ${withCheck}`]),
  ];
  const shape = (policy: PolicyFacts): string[] => [
    ...(policy.permissive === true ? [] : ['не PERMISSIVE']),
    ...(policy.command === '*' ? [] : [`команда ${policy.command}, а не ALL`]),
  ];
  const own = policies.find((policy) => policy.name === scope.policyName);
  if (own === undefined) {
    add(SCOPE_PROBLEM.policyMissing, `нет политики ${scope.policyName}`);
  } else {
    const differences = [
      ...shape(own),
      ...(own.applies === true ? [] : ['не действует на роль сессии']),
      ...expression(own, canonical?.qual, canonical?.withCheck),
    ];
    if (differences.length > 0) {
      add(SCOPE_PROBLEM.policyMismatch, `${scope.policyName}: ${differences.join('; ')}`);
    }
  }
  const maintenance =
    scope.maintenanceRole === null
      ? undefined
      : policies.find((policy) => policy.name === scope.maintenancePolicyName);
  if (maintenance !== undefined) {
    const differences = [
      ...shape(maintenance),
      ...(maintenance.roles.length === 1 && maintenance.roles[0] === scope.maintenanceRole
        ? []
        : [`роли ${maintenance.roles.join(', ')}, а не только «${scope.maintenanceRole}»`]),
      ...expression(maintenance, canonical?.maintenanceQual, canonical?.maintenanceWithCheck),
    ];
    if (differences.length > 0) {
      add(SCOPE_PROBLEM.policyMismatch, `${scope.maintenancePolicyName}: ${differences.join('; ')}`);
    }
  }
  // Разрешающая политика, оба выражения которой ложны (или одно ложно, а другого нет), к OR ничего не прибавляет.
  const grantsNothing = (policy: PolicyFacts): boolean =>
    (policy.qual !== null || policy.with_check !== null) &&
    (policy.qual === null || policy.qual === 'false') &&
    (policy.with_check === null || policy.with_check === 'false');
  for (const policy of policies) {
    if (
      policy !== own &&
      policy !== maintenance &&
      policy.permissive !== false &&
      policy.applies !== false &&
      !grantsNothing(policy)
    ) {
      add(
        SCOPE_PROBLEM.foreignPolicy,
        `разрешающая политика ${policy.name} (USING ${String(policy.qual)}) действует на роль и расширяет доступ через OR`,
      );
    }
  }
  if (facts.truncate !== false) {
    add(
      SCOPE_PROBLEM.truncatePrivilege,
      'у роли сессии есть право TRUNCATE: TRUNCATE политик не проходит и стирает строки всех областей (REVOKE TRUNCATE)',
    );
  }
  return problems;
}
