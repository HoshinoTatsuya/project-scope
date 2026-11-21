import type { ProjectScope } from '../types/project-scope.type';

/**
 * Условие политики роли сквозного доступа: контекст области НЕ задан. Роль
 * видит все строки только вне работы области — внутри `withScope` (контекст
 * задан) её политика ложна, и действует обычная политика изоляции. Иначе
 * `withScope` на пуле роли сквозного доступа молча видел бы и писал все
 * области: разрешающие политики складываются через OR.
 */
export function maintenancePredicateSql(scope: ProjectScope): string {
  return `NULLIF(current_setting('${scope.setting}', true), '') IS NULL`;
}
