import type { ScopeProblem } from '../types/scope-problem.type';

/** Изоляция области не действует: перечень причин — в `problems`, каждая со своим кодом. */
export class ScopeNotReadyError extends Error {
  override readonly name = 'ScopeNotReadyError';
  readonly problems: readonly ScopeProblem[];

  constructor(problems: readonly ScopeProblem[]) {
    super(
      `изоляция области не готова (${problems.length}):\n${problems
        .map(
          (problem) =>
            `  - [${problem.code}]${problem.table === null ? '' : ` ${problem.table}:`} ${problem.detail}`,
        )
        .join('\n')}`,
    );
    this.problems = Object.freeze(problems.map((problem) => Object.freeze({ ...problem })));
  }
}
