import { defineProjectScope, SCOPE_COLUMN_TYPE } from '@hoshinotatsuya/project-scope';
import { scopePgPolicies } from '@hoshinotatsuya/project-scope/drizzle';
import { pgTable, text, uuid } from 'drizzle-orm/pg-core';

export const tenantScope = defineProjectScope({
  setting: 'app.tenant_id',
  column: 'tenant_id',
  columnType: SCOPE_COLUMN_TYPE.uuid,
  tables: ['invoices'],
});

// drizzle-kit generates the policies and ENABLE ROW LEVEL SECURITY, but NOT `FORCE ROW LEVEL SECURITY`
// and NOT `REVOKE TRUNCATE`: add both to the same migration by hand
//   ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;
//   REVOKE TRUNCATE ON "invoices" FROM PUBLIC, CURRENT_USER;
// (the coverage gate and assertScopeReady catch a missing FORCE, assertScopeReady a TRUNCATE privilege).
export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    number: text('number').notNull(),
  },
  () => scopePgPolicies(tenantScope),
).enableRLS();
