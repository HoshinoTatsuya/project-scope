import type { ScopeColumnType } from './scope-column-type.type';

export interface ProjectScopeOptions<C extends ScopeColumnType = ScopeColumnType> {
  /**
   * Параметр Postgres, в котором транзакция несёт значение области:
   * `префикс.имя` в нижнем регистре (`app.project_id`).
   */
  readonly setting: string;
  /** Колонка области в каждой таблице списка (`project_id`, `tenant_id`). */
  readonly column: string;
  readonly columnType: C;
  /**
   * Таблицы области: `имя` (схема public) или `схема.имя`, нижний регистр.
   * Пустой список — отказ: «защищать нечего» неотличимо от забытой настройки.
   */
  readonly tables: readonly string[];
  /**
   * Роль сквозного доступа для обслуживающих задач (`withCrossScope`): её
   * политика видит все строки. Отдельная роль со своим входом, а не флаг в
   * запросе — роль приложения в неё входить не должна (проверяет
   * `assertScopeReady`). Не задана — сквозного доступа нет вовсе.
   */
  readonly maintenanceRole?: string;
}
