import type { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';

export type ScopeColumnType = (typeof SCOPE_COLUMN_TYPE)[keyof typeof SCOPE_COLUMN_TYPE];
