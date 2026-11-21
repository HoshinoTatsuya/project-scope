import { deepFreeze } from '../deep-freeze';

/**
 * Тип колонки области так, как его печатает `atttypid::regtype` — без
 * модификатора длины (`varchar(64)` — `character varying`), домен — своим
 * именем (то есть «не тот тип»).
 */
export const SCOPE_COLUMN_REGTYPE = {
  uuid: 'uuid',
  text: 'text',
  bigint: 'bigint',
  integer: 'integer',
  varchar: 'character varying',
} as const;

deepFreeze(SCOPE_COLUMN_REGTYPE);
