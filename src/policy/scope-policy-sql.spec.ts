import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { defineProjectScope } from '../scope/define-project-scope';
import { scopePolicySql } from './scope-policy-sql';

const scope = defineProjectScope({
  setting: 'app.project_id',
  column: 'project_id',
  columnType: SCOPE_COLUMN_TYPE.uuid,
  tables: ['items', 'audit.events'],
  maintenanceRole: 'app_maintenance',
});

const PREDICATE = `"project_id" = NULLIF(current_setting('app.project_id', true), '')::uuid`;
const MAINTENANCE = "NULLIF(current_setting('app.project_id', true), '') IS NULL";

describe('scopePolicySql', () => {
  it('каждая таблица: ENABLE, FORCE, изоляция с USING и WITH CHECK, политика роли сквозного доступа (только без контекста), отзыв TRUNCATE', () => {
    expect(scopePolicySql(scope, { tables: ['items'] }).split(';\n--> statement-breakpoint\n')).toEqual([
      'ALTER TABLE "items" ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE "items" FORCE ROW LEVEL SECURITY',
      `CREATE POLICY "scope_app_project_id" ON "items" AS PERMISSIVE FOR ALL TO PUBLIC USING (${PREDICATE}) WITH CHECK (${PREDICATE})`,
      `CREATE POLICY "scope_app_project_id_maintenance" ON "items" AS PERMISSIVE FOR ALL TO "app_maintenance" USING (${MAINTENANCE}) WITH CHECK (${MAINTENANCE})`,
      'REVOKE TRUNCATE ON "items" FROM PUBLIC, CURRENT_USER;\n',
    ]);
  });

  it('по умолчанию — все таблицы области, со схемой в кавычках по частям', () => {
    const sql = scopePolicySql(scope);
    expect(sql.match(/^ALTER TABLE \S+ FORCE ROW LEVEL SECURITY/gm)).toEqual([
      'ALTER TABLE "audit"."events" FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "items" FORCE ROW LEVEL SECURITY',
    ]);
  });

  it('без роли сквозного доступа её политики нет; тип колонки — в приведении', () => {
    const text = defineProjectScope({
      setting: 'app.tenant',
      column: 'tenant',
      columnType: SCOPE_COLUMN_TYPE.text,
      tables: ['labels'],
    });
    const sql = scopePolicySql(text);
    expect(sql).not.toContain('maintenance');
    expect(sql).toContain(`USING ("tenant" = NULLIF(current_setting('app.tenant', true), '')::text)`);
  });

  it('пустой список и недопустимое имя — отказ', () => {
    expect(() => scopePolicySql(scope, { tables: [] })).toThrow('пуст');
    expect(() => scopePolicySql(scope, { tables: ['items; DROP TABLE x'] })).toThrow('нижнем регистре');
  });
});
