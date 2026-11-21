/** Политика из текста миграции: выражения — нормализованы `policyTail`, роли — как их хранит Postgres. */
export interface PolicyForm {
  readonly permissive: boolean;
  /** `all`, `select`, `insert`, `update`, `delete`. */
  readonly command: string;
  /** Пусто — не указаны (PUBLIC). */
  readonly roles: readonly string[];
  readonly using: string | null;
  readonly check: string | null;
}
