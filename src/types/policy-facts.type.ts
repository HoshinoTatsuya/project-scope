/** Политика из `pg_policy`: выражения — как их печатает `pg_get_expr`. */
export interface PolicyFacts {
  relation: string;
  name: string;
  permissive: boolean;
  command: string;
  /** Действует на роль сессии (текущую или роль входа). */
  applies: boolean;
  /** Роли политики по именам (`public` — PUBLIC), по алфавиту. */
  roles: string[];
  qual: string | null;
  with_check: string | null;
}
