import { deepFreeze } from '../deep-freeze';

/**
 * Формы имён, которые пакет вставляет в SQL. Таблица, колонка и роль — простой
 * идентификатор БЕЗ кавычек и точек в самом имени, в любом регистре: в SQL они
 * всегда уходят в кавычках, и имя в списке — ровно имя в базе (`"Document"`,
 * `"projectId"` у Prisma). Параметр — только нижний регистр: имена параметров
 * Postgres регистр не различает. Длина — предел идентификатора (63 байта).
 */
export const SCOPE_IDENTIFIER = {
  name: /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/,
  qualifiedName: /^(?:[A-Za-z_][A-Za-z0-9_$]{0,62}\.)?[A-Za-z_][A-Za-z0-9_$]{0,62}$/,
  setting: /^[a-z_][a-z0-9_$]*\.[a-z_][a-z0-9_$]*$/,
  maxLength: 63,
} as const;

deepFreeze(SCOPE_IDENTIFIER);
