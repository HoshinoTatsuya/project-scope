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
