import { deepFreeze } from '../deep-freeze';
import { SCOPE_COLUMN_TYPE } from './scope-column-type.constant';

/** Форма значения области по типу колонки — проверяется до запроса. */
export const SCOPE_ID_FORMAT = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  integer: /^-?(?:0|[1-9][0-9]*)$/,
  range: {
    [SCOPE_COLUMN_TYPE.bigint]: [-(2n ** 63n), 2n ** 63n - 1n],
    [SCOPE_COLUMN_TYPE.integer]: [-(2n ** 31n), 2n ** 31n - 1n],
  },
} as const;

deepFreeze(SCOPE_ID_FORMAT);
