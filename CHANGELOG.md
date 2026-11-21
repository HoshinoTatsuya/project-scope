# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses
[Semantic Versioning](https://semver.org/) (before 1.0 a breaking change bumps the minor version).

## 0.3.2 — 2026-11-21

First public release as `@hoshinotatsuya/project-scope`, MIT; documentation in English and Russian; no
functional changes.

- README examples live in `examples/` and are type-checked against the sources (`pnpm typecheck`); the quick
  start was run against PostgreSQL 17.
- Test fixtures use neutral table names (`documents`); CI moved to GitHub Actions; development dependencies
  bumped (arch-gates 0.12.2, jest-groups 0.7.2, fault-kit 0.3.1).

## 0.3.1 — 2026-11-21

### Fixed

- `assertScopeReady` no longer crashes the process when the server drops a checked-out probe connection
  (`pg_terminate_backend`, `idle_session_timeout`, restart): pg-pool keeps no `'error'` handler on a checked-out
  client, so the drop used to be an unhandled `'error'`. Now it is `undetermined` in `ScopeNotReadyError`, and the
  broken connection is destroyed instead of being returned to the pool.

### Changed

- Peer `pg-runtime` accepts `^0.9.0`. No migration needed.

## 0.3.0 — 2026-11-17

Fixes from an external review. The gates are stricter — a project with violations not seen before gets a red
gate (which is the point); the API is extended without breaking.

### Fixed

- A nested `withScope` (savepoint) validates `localSettings` itself (role change and scope settings are refused).
- Migration gate: `BEGIN ATOMIC … END` bodies are no longer split by `;`; partitions survive `RENAME`/`SET SCHEMA`,
  `DETACH PARTITION` is read, `DROP TABLE` of a parent drops its partitions; a view renamed through
  `ALTER TABLE … RENAME` is judged under its new name.
- Schema gate: views are judged by their query (aggregates without the scope column, subqueries, views over views,
  `sql` templates); `notScoped` with a short reason or an unused entry is a violation also on a direct call
  (`MigrationScopeReport.usedNotScoped`).
- Reason lengths count visible characters (zero-width spaces, BOM, fillers and repeated spaces do not count).
- A drizzle journal with a BOM or invalid JSON is a gate failure with a reason.

### Changed

- Peer `pg-runtime`: `^0.7.1 || ^0.8.0`.

### Migration

Drizzle views aggregating a scope table need `.with({ securityInvoker: true })` or a `notScoped` entry; extend
reasons shorter than the threshold in visible characters; remove unused `notScoped` entries; list detached
partitions in the scope or in `notScoped`.

## 0.2.1 — 2026-11-17

### Changed

- Requires `pg-runtime` ≥ 0.7.1: session values of the scope setting and the cross-scope reason are reset at the
  end of the work by pg-runtime (`resetAppSettings`) to the session default, instead of a query that bypassed the
  pg-runtime connection wrapper.

### Migration

Upgrade `pg-runtime` to 0.7.1.

## 0.2.0 — 2026-11-16

Breaking changes.

### Changed

- Requires `pg-runtime` ≥ 0.7.0: the connection cleanup after a scope transaction returns it to its post-connect
  state (`search_path`, `TimeZone`, `application_name`, role and `LISTEN` from `pool.on('connect')` survive);
  custom `app.*` settings set with `SET` on connect are still cleared. The old cleanup: `sessionBaseline:
  'defaults'`.
- The maintenance policy is `NULLIF(current_setting('<setting>', true), '') IS NULL` instead of `true`: the
  maintenance role sees all rows only without a scope context.
- `scopePolicySql` revokes TRUNCATE; `assertScopeReady` reports `truncate-privilege`.
- `assertScopeReady` judges the catalog, not the list (new codes `inheritance-ancestor`, `unlisted-table`,
  `materialized-view`, `view-not-invoker`, `rewrite-rule`, `foreign-key-across-scopes`, `truncate-privilege`,
  `nondeterministic-collation`, `security-definer`, `routine-sets-scope`, `leakproof-function`, `user-mapping`);
  options `timeoutMs` and `canonicalFrom`; `SCOPE_COLUMN_TYPE.varchar`; identifiers in any case.
- `scopeCoverageGate` moved to the `/gate/jest` entry; `/gate` no longer loads `@jest/globals`.
- Stricter gate (foreign permissive policies, non-invoker and materialized views, rules, cross-scope foreign keys,
  `SELECT … INTO`, role grants, `BYPASSRLS`, `SECURITY DEFINER`, `ROLLBACK`, `standard_conforming_strings`,
  `UESCAPE`, …); migration order follows the tool (`migrationLayout`, `MIGRATION_LAYOUT`, `readMigrationFiles(dir,
  layout?)`), verified against golang-migrate 4.18.3, dbmate 2.38.1 and Flyway 11.20.3.
- `withScope`/`withCrossScope`: changing the context or the reason inside the work is `ScopeConflictError` with
  rollback; deferred queries after the work are refused; `resetSession: false` is refused; scope values never
  appear in error messages; stricter scope id validation.
- Types: `ProjectScope<C>` carries the column type, `withScope` accepts `ScopeId<C>`; `ScopeReadyOptions` and
  `ScopeId` exported.

### Migration

- Recreate the maintenance policies from `scopePolicySql(scope, { tables })` (or `scopePgPolicies`).
- `REVOKE TRUNCATE ON <scope tables> FROM PUBLIC, <owner>, <roles with GRANT ALL>;`.
- List tables with the scope column outside the list, rename the column or revoke access.
- Import `scopeCoverageGate` from `@hoshinotatsuya/project-scope/gate/jest`.
- `SECURITY DEFINER` functions over scope data: owner without RLS bypass, or `REVOKE EXECUTE … FROM PUBLIC`; drop
  LEAKPROOF; keep user mappings only for the maintenance role.
- dbmate directories with numbers of different length: rename with leading zeros; a drizzle journal with a
  decreasing `when`: fix it.

## 0.1.0 — 2026-11-15

First version: `defineProjectScope`, `scopePolicySql`, `scopePredicateSql`, `withScope`, `withCrossScope`,
`assertScopeReady` (`SCOPE_PROBLEM`, `ScopeNotReadyError`), `ScopeConflictError`, `CrossScopeRefusedError`;
entry `/drizzle` — `scopePgPolicies`; entry `/gate` — `scopeCoverageGate`, `evaluateScopeCoverage`,
`schemaScopeViolations`, `migrationScopeViolations`, `readMigrationFiles`.
