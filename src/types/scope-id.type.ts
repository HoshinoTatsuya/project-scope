import type { ScopeColumnType } from './scope-column-type.type';

/**
 * Значение области, которое принимает `withScope` для колонки типа `C`: целое
 * (`bigint`, `integer`) — строкой, числом или bigint; остальные — только
 * строкой. Тип колонки, известный лишь как объединение, принимает всё —
 * проверка остаётся за рантаймом (`scopeIdText`).
 */
export type ScopeId<C extends ScopeColumnType = ScopeColumnType> = C extends 'bigint' | 'integer'
  ? string | number | bigint
  : string;
