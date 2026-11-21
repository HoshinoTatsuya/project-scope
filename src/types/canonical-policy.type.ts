/** Выражения политик области так, как их разбирает и печатает этот сервер (`pg_get_expr`). */
export interface CanonicalPolicy {
  readonly qual: string;
  readonly withCheck: string;
  /** Политика роли сквозного доступа (все строки — только без контекста области). */
  readonly maintenanceQual: string;
  readonly maintenanceWithCheck: string;
}
