import { ROLE_SETTINGS } from '../constants/role-settings.constant';
import type { ProjectScope } from '../types/project-scope.type';
import type { ScopeTransactionOptions } from '../types/scope-transaction-options.type';

/**
 * `localSettings` вызывающего плюс свой параметр. Отказ — параметры, которые
 * задаёт сама функция (контекст и причина области), и смена роли транзакции
 * (`ROLE_SETTINGS`). Имена параметров Postgres регистр не различают —
 * `App.Project_Id` тот же параметр, что `app.project_id`.
 */
export function settingsWith(
  caller: string,
  scope: ProjectScope,
  options: ScopeTransactionOptions,
  name: string,
  value: string,
): Readonly<Record<string, string>> {
  const own = options.localSettings ?? {};
  const reserved = new Set([scope.setting, scope.reasonSetting, ...ROLE_SETTINGS]);
  for (const key of Object.keys(own)) {
    if (reserved.has(key.trim().toLowerCase())) {
      throw new Error(
        `${caller}: localSettings.${key} — параметр области или роли транзакции задаёт сама функция`,
      );
    }
  }
  return { ...own, [name]: value };
}
