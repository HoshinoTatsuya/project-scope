# @hoshinotatsuya/project-scope

[![npm](https://img.shields.io/npm/v/@hoshinotatsuya/project-scope.svg)](https://www.npmjs.com/package/@hoshinotatsuya/project-scope)
[![CI](https://github.com/HoshinoTatsuya/project-scope/actions/workflows/ci.yml/badge.svg)](https://github.com/HoshinoTatsuya/project-scope/actions/workflows/ci.yml)

[Русская версия](README.ru.md) · [Changelog](CHANGELOG.md)

Data isolation by scope — project, tenant, organization (the column and setting names are yours) — on
PostgreSQL row-level security, as a **second line of defence** behind `WHERE project_id = …` in your code.
One forgotten filter stops being a leak of other tenants' rows: a query sees and writes only the rows of the
scope of its transaction.

**The problem it solves.** Multi-tenant code filters every query by tenant. Sooner or later one query misses the
filter, and nothing notices until data leaks. RLS can enforce the filter in the database, but it is easy to get
subtly wrong: a policy that returns everything when the context is unset, a session-level `SET` that leaks the
context to the next pool user, a table owner that bypasses its own policies, a view or a foreign key that goes
around RLS. This package generates the policies, sets the context per transaction only, and **checks at
startup** (and in a CI gate) that none of these holes exist.

| What | With |
|---|---|
| Migration policies: ENABLE + FORCE RLS, a policy with USING and WITH CHECK (no context — zero rows and refused writes), a maintenance-role policy (all rows only without a context), REVOKE TRUNCATE | `scopePolicySql(scope)`; for drizzle-kit `scopePgPolicies(scope)` (entry `/drizzle`) |
| Scope context per transaction only (`SET LOCAL`); a different nested scope is refused; changing the context inside the work is refused and rolled back | `withScope(db, scope, id, work)` on top of `transactionKeepingFailure` from `@hoshinotatsuya/pg-runtime` |
| Cross-scope access for maintenance jobs — only under a dedicated role and with a reason | `withCrossScope(db, scope, { reason }, work)` |
| Startup check — one pass over the catalog: everything that touches scope data, not only the listed tables | `assertScopeReady(pool, scope, options?)` |
| Coverage gate for the schema and migrations — plain functions, no test runner | `evaluateScopeCoverage`, `schemaScopeViolations`, `migrationScopeViolations`, `readMigrationFiles` (entry `/gate`) |
| The same gate as a jest spec | `scopeCoverageGate({ scope, schema, migrations })` (entry `/gate/jest`) |

## Install

```sh
pnpm add @hoshinotatsuya/project-scope @hoshinotatsuya/pg-runtime drizzle-orm pg
pnpm add -D @types/pg   # optional, for TypeScript
```

| Peer | Range | Why |
|---|---|---|
| `@hoshinotatsuya/pg-runtime` | `^0.7.1 \|\| ^0.8.0 \|\| ^0.9.0` | transactions, session reset, pooler guard — **one copy per process** (nesting is detected through it) |
| `drizzle-orm` | `>=0.45.2 <0.46` | the database handle (`drizzle(pool)`), `scopePgPolicies`, the schema gate |
| `pg` | `^8.18.0` | driver |
| `@jest/globals` | `>=29` (optional) | only for the `/gate/jest` entry |
| `@types/pg` | `>=8.15.0` (optional) | types |

Entries: `@hoshinotatsuya/project-scope` (runtime), `/drizzle` (drizzle-kit policies), `/gate` (gate functions,
loads outside jest), `/gate/jest` (ready-made jest spec). CommonJS with ESM type declarations; checked with
`commonjs`, `node16`, `nodenext` and `bundler` resolution.

## Quick start

<!-- example: examples/scope.ts -->
```ts
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
```

What the migration produces for each table:

```sql
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "scope_app_project_id" ON "documents" AS PERMISSIVE FOR ALL TO PUBLIC
  USING ("project_id" = NULLIF(current_setting('app.project_id', true), '')::uuid)
  WITH CHECK ("project_id" = NULLIF(current_setting('app.project_id', true), '')::uuid);
CREATE POLICY "scope_app_project_id_maintenance" ON "documents" AS PERMISSIVE FOR ALL TO "app_maintenance"
  USING (NULLIF(current_setting('app.project_id', true), '') IS NULL)
  WITH CHECK (NULLIF(current_setting('app.project_id', true), '') IS NULL); -- only with maintenanceRole
REVOKE TRUNCATE ON "documents" FROM PUBLIC, CURRENT_USER;
```

The maintenance role is a separate login without superuser or BYPASSRLS:

```sql
CREATE ROLE app_maintenance LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS;
GRANT SELECT, INSERT, UPDATE, DELETE ON documents, comments TO app_maintenance;
```

The quick start above was run against PostgreSQL 17 under a non-superuser application role that owns the
tables: `assertScopeReady` passes, `listDocuments` returns only the project's rows, a query **without** `WHERE`
inside `withScope` also returns only them, a query without a context returns zero rows, and `withCrossScope`
under the application role is refused with `CrossScopeRefusedError`.

With drizzle-kit, declare the policies on the table:

<!-- example: examples/drizzle-schema.ts -->
```ts
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
```

The coverage gate in your test suite:

<!-- example: examples/scope-coverage.spec.ts -->
```ts
// A jest spec in your project: the schema and every migration keep the scope covered.
import { join } from 'node:path';

import { MIGRATION_LAYOUT } from '@hoshinotatsuya/project-scope/gate';
import { scopeCoverageGate } from '@hoshinotatsuya/project-scope/gate/jest';

import * as schema from './drizzle-schema';
import { tenantScope } from './drizzle-schema';

scopeCoverageGate({
  scope: tenantScope,
  schema, // drizzle tables (the module's exports)
  migrations: join(__dirname, '../drizzle'), // the migrations directory
  migrationLayout: MIGRATION_LAYOUT.drizzle, // drizzle | flyway | golang-migrate | dbmate
  minSchemaTables: 1, // the selection must not degenerate: "0 violations" over 0 tables means nothing
  casing: 'snake_case', // the same `casing` as drizzle(pool, { casing })
});
```

Every example in this README is a file in [`examples/`](examples), type-checked against the package sources by
`pnpm typecheck`.

## API

### `defineProjectScope(options)` → `ProjectScope`

| Option | Meaning |
|---|---|
| `setting` | transaction setting carrying the scope id, `prefix.name`, lower case (e.g. `app.project_id`); names ending in `_maintenance` or `_cross_reason` are rejected (they are derived names of another scope) |
| `column` | the scope column in every listed table |
| `columnType` | `SCOPE_COLUMN_TYPE`: `uuid`, `text`, `varchar` (any length), `bigint`, `integer` — exactly the column type |
| `tables` | the tables of the scope (`schema.table` allowed) |
| `maintenanceRole` | optional; the only role whose policy sees all rows (and only without a context) |

Tables, columns and roles are plain identifiers in any case (`"Document"`, `"projectId"` from Prisma): SQL always
quotes them, the name you give is the exact name in the database. The returned scope also carries the derived
`policyName`, `maintenancePolicyName` and `reasonSetting` (`<setting>_cross_reason`).

### `scopePolicySql(scope, { tables? })` → `string`

DDL for a migration: for every table (or only `tables`, e.g. a new table or partition) ENABLE + FORCE RLS, the
scope policy, the maintenance policy (with `maintenanceRole`) and REVOKE TRUNCATE. `scopePredicateSql(scope)` is
the bare predicate.

### `scopePgPolicies(scope)` (entry `/drizzle`) → `PgPolicy[]`

The same policies as drizzle objects for the third argument of `pgTable` with `.enableRLS()`. drizzle-kit does not
generate FORCE and REVOKE TRUNCATE — add them to the migration (the gate and `assertScopeReady` catch the omission).

### `withScope(db, scope, scopeId, work, options?)` → `Promise<T>`

Runs `work(tx, client)` in a transaction with `set_config(setting, id, true)` (transaction-local):

- `scopeId` is typed by the column type (`ScopeId<C>`: a string for uuid/text/varchar, a number or bigint for
  integer types) and validated before any query: empty, not a uuid, out of range, control or invisible
  characters, lone surrogates, surrounding spaces, non-NFKC text are rejected; the value never appears in error
  messages;
- the context must be unchanged at the end of the work, and no cross-scope reason may be set — otherwise
  `ScopeConflictError` and rollback; session values of both settings are reset before COMMIT;
- a nested `withScope` of the same scope and value on the same pool is a savepoint; another value, another scope
  on the same pool or a cross-scope frame — `ScopeConflictError`;
- without a pooler the connection is fully cleaned after the transaction (`resetSession` of pg-runtime);
- `options` are the `transactionKeepingFailure` options of pg-runtime (`statementTimeoutMs`, `retry`,
  `transactionPooler`, `localSettings`, …) except `nested`; `resetSession` may only be `true`; `localSettings` may
  not contain the scope settings or a role change.

**Authorization stays yours:** check that the user may access `scopeId` before calling `withScope`.

### `withCrossScope(db, scope, { reason }, work, options?)` → `Promise<T>`

Maintenance work across all scopes. The pool must be opened under `scope.maintenanceRole`, otherwise
`CrossScopeRefusedError` before the work (a job would otherwise "succeed" on an empty set). The reason (10–1000
visible characters, `CROSS_SCOPE_LIMITS`) goes to the transaction setting `scope.reasonSetting` for audit
triggers; setting a scope context or changing the reason inside the work — `ScopeConflictError` and rollback.

### `assertScopeReady(pool, scope, { timeoutMs?, canonicalFrom? })` → `Promise<void>`

Call it at startup with the pool the application works under. It judges the **catalog**, not the list: listed
tables, their partitions and descendants, their ancestors, any table or view with the scope column in any schema,
views and materialized views over scope data, foreign keys, rules, `SECURITY DEFINER` functions the session can
reach, LEAKPROOF functions, user mappings, and the privileges of both `current_user` and `session_user` (with
every role they can use). Failure — `ScopeNotReadyError` with **all** problems (`problems: { code, table,
detail }[]`):

| Code (`SCOPE_PROBLEM`) | What is wrong |
|---|---|
| `superuser`, `bypass-rls` | the current or login role bypasses RLS entirely |
| `escalation` | REPLICATION, CREATEROLE below PostgreSQL 16, membership in such roles or in the server-file roles, EXECUTE on server-file functions |
| `maintenance-role`, `member-of-maintenance-role` | the pool runs as the maintenance role, or the app role is its member |
| `context-outside-transaction` | the scope setting (or the reason) is set at session, role or database level |
| `table-missing`, `column-mismatch` | a listed table or its column is missing or of another type |
| `nondeterministic-collation` | the scope column uses a nondeterministic collation (`acme` = `ACME`) |
| `rls-disabled`, `rls-not-forced`, `owner-without-force` | RLS off, or without FORCE |
| `policy-missing`, `policy-mismatch`, `foreign-policy` | the scope policy is missing or different, or another permissive policy applies to the role |
| `truncate-privilege` | the session role may TRUNCATE a scope table |
| `unlisted-table` | a table with the scope column that is neither listed nor a partition/descendant of a listed one |
| `materialized-view`, `view-not-invoker` | a materialized view over scope data; a view without `security_invoker = true` not owned by the session role |
| `inheritance-ancestor` | an accessible inheritance ancestor without the scope column |
| `foreign-key-across-scopes` | a foreign key to a scope table without the scope column pair; a cascade from a shared table the session can modify |
| `rewrite-rule` | a rule on scope data |
| `security-definer`, `routine-sets-scope`, `leakproof-function`, `user-mapping` | owner-rights code, functions setting the scope, LEAKPROOF outside `pg_catalog`, foreign-server mappings |
| `undetermined` | the check could not run or did not finish within `timeoutMs` — a refusal, never "ready" |

`timeoutMs` defaults to 30 000. The policy reference is built by the server itself in a rolled-back `READ WRITE`
transaction on a temporary table (needs `TEMP` on the database); a hot standby cannot write — pass
`canonicalFrom: primaryPool`.

### Gate (entries `/gate` and `/gate/jest`)

- `scopeCoverageGate(options)` — registers a jest `describe` with the checks below.
- `evaluateScopeCoverage(options)` → `{ violations, schemaTables, migrations, scopedInSchema, scopedInMigrations }`.
- `schemaScopeViolations(scope, schema, { casing?, notScoped? })`, `migrationScopeViolations(scope, files,
  { adoptedLater?, notScoped? })`, `readMigrationFiles(dir, layout?)`, `MIGRATION_LAYOUT`.

Options of the coverage: `scope`, `schema` (drizzle module exports), `migrations` (a directory or
`MigrationFile[]` in apply order), `migrationLayout` (`drizzle` — by `meta/_journal.json`, `flyway`,
`golang-migrate`, `dbmate`; ordering rules were verified against the real tools), `minSchemaTables`,
`minMigrations`, `casing`, `notScoped: { name: reason }`, `adoptedLater: { table: reason }` (reasons ≥ 20 visible
characters).

What it enforces:

- the selection did not degenerate (tables and migrations above the thresholds, scope tables found);
- every drizzle table with the scope column is listed and every listed table has it (with drizzle `casing`);
- the migration that gives a table the scope column also enables, forces and creates the exact scope policy, and
  later migrations never weaken it; at the end of history every listed table is protected;
- no foreign permissive policies, materialized views or non-invoker views over scope data, rules, cross-scope
  foreign keys, inheritance from tables without the column;
- immediate violations: membership in the maintenance role or server-file roles, `BYPASSRLS`/`SUPERUSER`/
  `REPLICATION`/`CREATEROLE`, `SECURITY DEFINER` over scope data, `search_path` changes, and SQL the parser would
  read differently from the server (`ROLLBACK`, `standard_conforming_strings`, `UESCAPE`, …). "Cannot determine"
  is a violation.

Its limit: `DO $$…$$` bodies and dynamic SQL are not read — `assertScopeReady` finds their results in the catalog.

### Errors

| Error | When |
|---|---|
| `ScopeNotReadyError` | `assertScopeReady` found problems (`problems`) |
| `ScopeConflictError` | nested scopes conflict, or the work changed the context or the reason |
| `CrossScopeRefusedError` | `withCrossScope` without `maintenanceRole` or not under that role |
| `Error` from `defineProjectScope`, `withScope`, `assertScopeReady` | invalid options or scope id (before any query) |

## Guarantees and limits

Guaranteed (each checked against a real server):

- without a context a query on a scope table reads **zero rows** and every write is refused (`42501`);
- the context is transaction-local: the next pool user (and a neighbour behind PgBouncer in transaction mode) never
  sees it; session-level leftovers of the work are reset before COMMIT;
- the table owner does not bypass the policies (FORCE), TRUNCATE is revoked;
- the maintenance role sees all scopes only without a context, and only it does.

Not provided — by design:

- **not authorization**: RLS does not know who is asking; verify ownership of the id (BOLA/IDOR) before
  `withScope`;
- **not a replacement for `WHERE`**: keep the filter (intent and planner);
- **not a defence against the schema owner or malice**: an owner can disable RLS; the migration gate reads text;
  run migrations and the application under different roles where possible;
- **existence of other scopes' rows can leak through uniqueness and foreign keys** (`23505`, `23503`): use
  unpredictable keys (uuid) or keys with the scope column, foreign keys by the scope column pair;
- channels that do not go through table rows: copy triggers into shared tables, `pg_notify`, `pg_stat_activity`
  query texts under the same role (pass values as parameters), logical replication and `pg_dump` as superuser;
- behind PgBouncer in transaction mode temporary tables of the work must be `ON COMMIT DROP` (pg-runtime refuses
  other forms before sending);
- your own `app.*` settings set with `SET` on connect are not restored after a scope transaction — set them in the
  startup packet, on the role, or per transaction.

Cost (`bench/policy-cost.cjs`, PostgreSQL 17, 1 000 000 rows, 1000 scopes, B-tree on the scope column): the
policy becomes an index condition, so a query that forgot `WHERE` uses the same index plan as one with it; policy
plus filter costs about 0.04 ms at the median. Without an index on the scope column every query would be a full
scan — the index is mandatory.

## Failure behavior

Fails closed everywhere:

- unset context → zero rows and refused writes, never "all rows";
- `assertScopeReady` that cannot finish or cannot determine something → `ScopeNotReadyError` (`undetermined`),
  the probing connection is destroyed, not returned to the pool;
- a broken connection during the startup check does not crash the process — it is reported as `undetermined`;
- an invalid scope id, option, or a context change inside the work → an error before or instead of COMMIT;
- the gate treats SQL it cannot read as a violation.

## Adopting existing tables

Order matters: a policy without a context returns zero rows, so the code must set the context before RLS is on.

1. Add the scope column, backfill, `SET NOT NULL`, `CREATE INDEX CONCURRENTLY` on it; move cross-table foreign keys
   to scope column pairs.
2. Wrap all access in `withScope` (harmless before RLS), maintenance jobs in `withCrossScope` under the new role.
3. Migration: `scopePolicySql(scope)` for these tables (with `lock_timeout` and retry); list them in
   `adoptedLater` of the gate with a reason.
4. Startup: `assertScopeReady(pool, scope)` once the migration reached every database.

Rollback: `ALTER TABLE … DISABLE ROW LEVEL SECURITY` (code with `withScope` keeps working).

## Compatibility

- Node.js ≥ 24.
- PostgreSQL 15, 16, 17, 18 (the full suite runs on each); real PgBouncer in transaction mode in front of 15–18;
  hot standby on 16–18. Below 15 there is no `security_invoker` for views. Odyssey is not tested.
- `@hoshinotatsuya/pg-runtime` 0.7.1+, `drizzle-orm` 0.45.x, `pg` 8.18+.

## Testing and development

```sh
pnpm install
pnpm typecheck        # sources, examples, and README examples verbatim
pnpm lint
pnpm test             # needs Docker: a throwaway postgres:17-alpine (PG_TEST_URL — an existing server)
pnpm test:replica     # needs Docker: primary + hot standby (streaming replication)
pnpm test:pgbouncer   # needs Docker: PostgreSQL behind PgBouncer (edoburu/pgbouncer) in transaction mode
pnpm test:consumers   # packs the build into throwaway commonjs/node16/nodenext/ESM projects
pnpm build
```

Tests run through `jest-groups`: groups of at most 300 tests, one after another, at most 2 workers. Database
suites run under an **application role without superuser and BYPASSRLS that owns the tables** (the strictest
layout); `PG_TEST_IMAGE=postgres:15-alpine` (… `18-alpine`) selects the server version.
`scripts/layout-oracle.sh` re-records how golang-migrate, dbmate and Flyway order the migration fixtures.

## License

[MIT](LICENSE) © 2026 Hoshino Tatsuya
