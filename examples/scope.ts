import {
  assertScopeReady,
  defineProjectScope,
  SCOPE_COLUMN_TYPE,
  scopePolicySql,
  withCrossScope,
  withScope,
} from '@hoshinotatsuya/project-scope';
import { eq, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';

// 1. The scope: which transaction setting carries the scope id, which column holds it, which tables it guards.
export const projectScope = defineProjectScope({
  setting: 'app.project_id', // transaction setting, `prefix.name`
  column: 'project_id', // the scope column in every listed table
  columnType: SCOPE_COLUMN_TYPE.uuid, // exactly the column type: uuid | text | varchar | bigint | integer
  tables: ['documents', 'comments'],
  maintenanceRole: 'app_maintenance', // optional: the only role allowed to see all scopes
});

// 2. Migration: ENABLE + FORCE RLS, the scope policy (USING and WITH CHECK), the maintenance policy,
// REVOKE TRUNCATE — for every table of the scope (or `{ tables: [...] }` for a new one).
export const migrationSql = [
  `CREATE TABLE documents (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     project_id uuid NOT NULL,
     title text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  'CREATE INDEX documents_project_id_idx ON documents (project_id)',
  `CREATE TABLE comments (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     project_id uuid NOT NULL,
     document_id uuid NOT NULL,
     body text NOT NULL,
     UNIQUE (project_id, id)
   )`,
  'ALTER TABLE documents ADD UNIQUE (project_id, id)',
  // A foreign key between scope tables carries the scope column too, otherwise it bypasses RLS.
  'ALTER TABLE comments ADD FOREIGN KEY (project_id, document_id) REFERENCES documents (project_id, id)',
  scopePolicySql(projectScope),
].join(';\n');

const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').notNull(),
  title: text('title').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 3. Startup: fail closed if the role, the catalog or the policies do not isolate the scope.
export const startup = async (pool: Pool): Promise<void> => {
  await assertScopeReady(pool, projectScope); // throws ScopeNotReadyError listing every problem
};

// 4. Requests: the scope id lives only for one transaction (SET LOCAL). Check that the user may access the
// project BEFORE this call — RLS separates scopes, it does not know who is asking.
export const listDocuments = (pool: Pool, projectId: string) =>
  withScope(drizzle(pool), projectScope, projectId, (tx) =>
    // The WHERE stays: the policy catches the place where it was forgotten.
    tx.select().from(documents).where(eq(documents.projectId, projectId)),
  );

// 5. Maintenance across all scopes: only through a pool opened under the maintenance role, with a reason.
export const purgeOldDocuments = (maintenancePool: Pool, before: Date) =>
  withCrossScope(
    drizzle(maintenancePool),
    projectScope,
    { reason: 'retention: delete documents older than 90 days' }, // 10-1000 visible characters
    (tx) => tx.delete(documents).where(lt(documents.createdAt, before)),
  );
