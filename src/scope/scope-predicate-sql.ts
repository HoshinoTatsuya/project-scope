import type { ProjectScope } from '../types/project-scope.type';
import { quoteIdentifier } from './quote-identifier';

/**
 * Условие политики: колонка равна значению контекста транзакции.
 *
 * Незаданный контекст — NULL, а не пустая строка: `current_setting(…, true)`
 * отдаёт NULL, пока параметр в сессии не встречался, и `''` после того, как
 * транзакция с ним закончилась. `NULLIF(…, '')` сводит оба к NULL, а сравнение
 * с NULL не истинно ни для одной строки — ноль строк на чтении и отказ
 * WITH CHECK на записи. Без NULLIF пустая строка совпала бы со строкой, у
 * которой колонка (text) пуста, а у uuid-колонки дала бы ошибку приведения
 * вместо «нет строк». Сентинел «не задано» — NULL — не равен ни одному значению.
 *
 * `current_setting` — STABLE: выражение вычисляется один раз на запрос, и
 * индекс по колонке области работает (замер — в README).
 */
export function scopePredicateSql(scope: ProjectScope): string {
  return `${quoteIdentifier(scope.column)} = NULLIF(current_setting('${scope.setting}', true), '')::${scope.columnType}`;
}
