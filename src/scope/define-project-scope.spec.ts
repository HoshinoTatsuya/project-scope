import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import type { ProjectScopeOptions } from '../types/project-scope-options.type';
import { defineProjectScope } from './define-project-scope';

const VALID: ProjectScopeOptions = {
  setting: 'app.project_id',
  column: 'project_id',
  columnType: SCOPE_COLUMN_TYPE.uuid,
  tables: ['public.items', 'audit.events', 'notes'],
  maintenanceRole: 'app_maintenance',
};

describe('defineProjectScope', () => {
  it('нормализует и замораживает описание; имена политик и параметра причины — из setting', () => {
    const scope = defineProjectScope(VALID);
    expect(scope).toEqual({
      setting: 'app.project_id',
      column: 'project_id',
      columnType: 'uuid',
      tables: ['audit.events', 'items', 'notes'],
      maintenanceRole: 'app_maintenance',
      policyName: 'scope_app_project_id',
      maintenancePolicyName: 'scope_app_project_id_maintenance',
      reasonSetting: 'app.project_id_cross_reason',
    });
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.tables)).toBe(true);
    expect(defineProjectScope({ ...VALID, maintenanceRole: undefined } as never).maintenanceRole).toBeNull();
  });

  it.each([
    ['setting без префикса', { setting: 'project_id' }, 'setting'],
    ['setting в верхнем регистре', { setting: 'App.project_id' }, 'setting'],
    ['setting с кавычкой', { setting: "app.x'--" }, 'setting'],
    ['колонка с пробелом', { column: 'project id' }, 'column'],
    ['колонка с точкой', { column: 'project.id' }, 'column'],
    ['неизвестный тип', { columnType: 'json' }, 'columnType'],
    ['пустой список таблиц', { tables: [] }, 'tables пуст'],
    ['таблица в кавычках', { tables: ['"items"'] }, 'таблица'],
    ['три части имени', { tables: ['a.b.c'] }, 'таблица'],
    ['повтор таблицы (public и без схемы)', { tables: ['items', 'public.items'] }, 'повторена: items'],
    ['роль с дефисом', { maintenanceRole: 'app-maint' }, 'maintenanceRole'],
    ['слишком длинный setting', { setting: `app.${'x'.repeat(60)}` }, 'длиннее 63'],
    [
      'имя политики совпало бы с политикой сквозного доступа другой области',
      { setting: 'app.x_maintenance' },
      '_maintenance',
    ],
    [
      'параметр совпал бы с причиной другой области',
      { setting: 'app.project_id_cross_reason' },
      '_cross_reason',
    ],
  ])('%s — отказ', (_label, patch, message) => {
    expect(() => defineProjectScope({ ...VALID, ...patch } as ProjectScopeOptions)).toThrow(message);
  });
});
