import type { SCOPE_PROBLEM } from '../constants/scope-problem.constant';

export type ScopeProblemCode = (typeof SCOPE_PROBLEM)[keyof typeof SCOPE_PROBLEM];
