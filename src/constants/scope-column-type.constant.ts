import { deepFreeze } from '../deep-freeze';

/**
 * Тип колонки области. Значение контекста приводится к нему в политике
 * (`NULLIF(current_setting(…), '')::<тип>`), и колонка в базе обязана быть
 * ровно этого типа: иначе сравнение шло бы через неявное приведение, а
 * проверка на старте сверяла бы политику с другим выражением.
 */
export const SCOPE_COLUMN_TYPE = {
  uuid: 'uuid',
  text: 'text',
  bigint: 'bigint',
  integer: 'integer',
  /** `varchar(n)` любой длины (Prisma `String`): сравнение идёт как text. */
  varchar: 'varchar',
} as const;

deepFreeze(SCOPE_COLUMN_TYPE);
