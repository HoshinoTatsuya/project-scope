/** Состояние таблицы по миграциям, прочитанным к этому месту. */
export interface ScopeTableState {
  /** Есть колонка области. */
  scoped: boolean;
  rls: boolean;
  force: boolean;
  policy: boolean;
  /** Защита уже была полной в конце какой-то миграции: её снятие дальше — нарушение. */
  protectedOnce: boolean;
}
