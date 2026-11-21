import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { SCOPE_IDENTIFIER } from '../constants/scope-identifier.constant';
import { deepFreeze } from '../deep-freeze';
import type { ProjectScope } from '../types/project-scope.type';
import type { ProjectScopeOptions } from '../types/project-scope-options.type';
import type { ScopeColumnType } from '../types/scope-column-type.type';
import { normalizeTableName } from './normalize-table-name';

/**
 * Описание области: параметр контекста, колонка, её тип и таблицы. Из него
 * строятся политики (`scopePolicySql`), контекст (`withScope`), проверка на
 * старте (`assertScopeReady`) и гейт (`scopeCoverageGate`) — одно описание на
 * все четыре, чтобы они не разошлись.
 *
 * Всё, что уходит в SQL, проверяется здесь: имена — простые идентификаторы в
 * нижнем регистре, параметр — `префикс.имя`. Пустой список таблиц и повтор
 * таблицы — отказ.
 */
export function defineProjectScope<C extends ScopeColumnType>(
  options: ProjectScopeOptions<C>,
): ProjectScope<C> {
  const fail = (message: string): never => {
    throw new Error(`defineProjectScope: ${message}`);
  };
  if (typeof options.setting !== 'string' || !SCOPE_IDENTIFIER.setting.test(options.setting)) {
    fail(`setting «${String(options.setting)}» — вида префикс.имя в нижнем регистре (app.project_id)`);
  }
  if (typeof options.column !== 'string' || !SCOPE_IDENTIFIER.name.test(options.column)) {
    fail(`column «${String(options.column)}» — простой идентификатор в нижнем регистре`);
  }
  if (!Object.values<string>(SCOPE_COLUMN_TYPE).includes(options.columnType)) {
    fail(`columnType — ${Object.values(SCOPE_COLUMN_TYPE).join(' | ')}`);
  }
  if (!Array.isArray(options.tables) || options.tables.length === 0) {
    fail('tables пуст — область без таблиц ничего не защищает');
  }
  const tables = options.tables.map((table) => {
    if (typeof table !== 'string' || !SCOPE_IDENTIFIER.qualifiedName.test(table)) {
      fail(`таблица «${String(table)}» — имя или схема.имя в нижнем регистре`);
    }
    return normalizeTableName(table);
  });
  const repeated = tables.filter((table, index) => tables.indexOf(table) !== index);
  if (repeated.length > 0) {
    fail(`таблица повторена: ${[...new Set(repeated)].join(', ')}`);
  }
  const maintenanceRole = options.maintenanceRole ?? null;
  if (maintenanceRole !== null && !SCOPE_IDENTIFIER.name.test(maintenanceRole)) {
    fail(`maintenanceRole «${String(maintenanceRole)}» — простой идентификатор в нижнем регистре`);
  }
  const policyName = `scope_${options.setting.replace('.', '_')}`;
  const maintenancePolicyName = `${policyName}_maintenance`;
  // Имена, производные от setting, не должны совпадать с производными другой
  // области: политика `app.x_maintenance` назвалась бы как политика сквозного
  // доступа области `app.x`, параметр `app.x_cross_reason` — как её причина.
  if (policyName.endsWith('_maintenance') || options.setting.endsWith('_cross_reason')) {
    fail(
      `setting «${options.setting}» оканчивается на _maintenance или _cross_reason — так называются производные имена другой области`,
    );
  }
  if (maintenancePolicyName.length > SCOPE_IDENTIFIER.maxLength) {
    fail(`имя политики «${maintenancePolicyName}» длиннее ${SCOPE_IDENTIFIER.maxLength}: короче setting`);
  }
  const scope: ProjectScope<C> = {
    setting: options.setting,
    column: options.column,
    columnType: options.columnType,
    tables: [...tables].sort(),
    maintenanceRole,
    policyName,
    maintenancePolicyName,
    reasonSetting: `${options.setting}_cross_reason`,
  };
  deepFreeze(scope);
  return scope;
}
