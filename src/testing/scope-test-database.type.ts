import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

/**
 * Отдельная база набора и три роли:
 * - `app` — роль ПРИЛОЖЕНИЯ: без суперправ и BYPASSRLS, ВЛАДЕЛЕЦ базы и таблиц
 *   (сама выполняет миграции — частая и самая строгая раскладка: без FORCE
 *   владелец политик не проходит). Суперпользователь обходит RLS целиком, и
 *   проверка изоляции под ним была бы зелёной по неправильной причине;
 * - `maintenance` — роль сквозного доступа со своим входом;
 * - `reader` — ещё одна роль без суперправ и НЕ владелец (права GRANT).
 * `admin` — суперпользователь той же базы, только для фикстур и контроля.
 */
export interface ScopeTestDatabase {
  readonly roles: { readonly app: string; readonly maintenance: string; readonly reader: string };
  readonly urls: {
    readonly admin: string;
    readonly app: string;
    readonly maintenance: string;
    readonly reader: string;
  };
  readonly admin: Pool;
  readonly app: Pool;
  readonly appDb: NodePgDatabase & { readonly $client: Pool };
  readonly maintenance: Pool;
  readonly maintenanceDb: NodePgDatabase & { readonly $client: Pool };
  readonly reader: Pool;
  /** Пул роли с указанным потолком соединений (закрывается в `drop`). */
  pool(role: 'app' | 'maintenance' | 'reader' | 'admin', max: number): Pool;
  /**
   * Ещё одна роль со входом и её пул (`attributes` — атрибуты CREATE ROLE,
   * например BYPASSRLS). Роль удаляется в `drop`.
   */
  extraRole(label: string, attributes?: string): Promise<{ readonly role: string; readonly pool: Pool }>;
  drop(): Promise<void>;
}
