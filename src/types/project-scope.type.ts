import type { ScopeColumnType } from './scope-column-type.type';

/**
 * Проверенное и замороженное описание области (`defineProjectScope`). Тип
 * колонки — параметр типа: по нему `withScope` принимает значение области
 * (`ScopeId`) — число для uuid-области отвергают типы, а не только рантайм.
 */
export interface ProjectScope<C extends ScopeColumnType = ScopeColumnType> {
  readonly setting: string;
  readonly column: string;
  readonly columnType: C;
  /** Имена без схемы public: `items`, `audit.events`. */
  readonly tables: readonly string[];
  readonly maintenanceRole: string | null;
  /** Политика изоляции на каждой таблице. */
  readonly policyName: string;
  /** Политика роли сквозного доступа (если роль задана). */
  readonly maintenancePolicyName: string;
  /** Параметр транзакции с причиной сквозного доступа — для триггеров аудита. */
  readonly reasonSetting: string;
}
