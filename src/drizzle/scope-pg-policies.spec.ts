import { PgDialect } from 'drizzle-orm/pg-core';

import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { defineProjectScope } from '../scope/define-project-scope';
import { maintenancePredicateSql } from '../scope/maintenance-predicate-sql';
import { scopePredicateSql } from '../scope/scope-predicate-sql';
import { scopePgPolicies } from './scope-pg-policies';

const dialect = new PgDialect();

describe('scopePgPolicies', () => {
  it('та же политика, что scopePolicySql: ALL, PERMISSIVE, PUBLIC, одно выражение в USING и WITH CHECK', () => {
    const scope = defineProjectScope({
      setting: 'app.project_id',
      column: 'project_id',
      columnType: SCOPE_COLUMN_TYPE.uuid,
      tables: ['items'],
      maintenanceRole: 'app_maintenance',
    });
    const policies = scopePgPolicies(scope).map((policy) => ({
      name: policy.name,
      as: policy.as,
      for: policy.for,
      to: policy.to,
      using: policy.using === undefined ? null : dialect.sqlToQuery(policy.using).sql,
      withCheck: policy.withCheck === undefined ? null : dialect.sqlToQuery(policy.withCheck).sql,
    }));
    expect(policies).toEqual([
      {
        name: 'scope_app_project_id',
        as: 'permissive',
        for: 'all',
        to: 'public',
        using: scopePredicateSql(scope),
        withCheck: scopePredicateSql(scope),
      },
      {
        name: 'scope_app_project_id_maintenance',
        as: 'permissive',
        for: 'all',
        to: 'app_maintenance',
        using: maintenancePredicateSql(scope),
        withCheck: maintenancePredicateSql(scope),
      },
    ]);
  });

  it('без роли сквозного доступа — одна политика', () => {
    const scope = defineProjectScope({
      setting: 'app.tenant',
      column: 'tenant',
      columnType: SCOPE_COLUMN_TYPE.text,
      tables: ['labels'],
    });
    expect(scopePgPolicies(scope).map((policy) => policy.name)).toEqual(['scope_app_tenant']);
  });
});
