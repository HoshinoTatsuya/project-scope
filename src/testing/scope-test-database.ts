import { randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';

import { PG_TEST_URL } from './pg-test-url';
import type { ScopeTestDatabase } from './scope-test-database.type';

export const createScopeTestDatabase = async (): Promise<ScopeTestDatabase> => {
  const urlFor = (base: URL, database: string, role?: string): string => {
    const url = new URL(base.toString());
    url.pathname = `/${database}`;
    if (role !== undefined) {
      url.username = role;
      url.password = 'app';
    }
    return url.toString();
  };
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const name = `scope_${suffix}`;
  const roles = {
    app: `scope_app_${suffix}`,
    maintenance: `scope_maint_${suffix}`,
    reader: `scope_reader_${suffix}`,
  };
  const base = new URL(PG_TEST_URL as string);
  const root = new Client({ connectionString: PG_TEST_URL });
  await root.connect();
  try {
    for (const role of Object.values(roles)) {
      await root.query(
        `CREATE ROLE ${role} LOGIN PASSWORD 'app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
      );
    }
    await root.query(`CREATE DATABASE ${name} OWNER ${roles.app}`);
  } finally {
    await root.end();
  }
  const urls = {
    admin: urlFor(base, name),
    app: urlFor(base, name, roles.app),
    maintenance: urlFor(base, name, roles.maintenance),
    reader: urlFor(base, name, roles.reader),
  };
  const pools: Pool[] = [];
  const extraRoles: string[] = [];
  const pool = (role: keyof typeof urls, max: number): Pool => {
    const created = new Pool({ connectionString: urls[role], max });
    pools.push(created);
    return created;
  };
  const app = pool('app', 10);
  const maintenance = pool('maintenance', 4);
  // Контроль фикстуры: роли действительно без суперправ и без BYPASSRLS.
  for (const [role, checked] of [
    ['app', app],
    ['maintenance', maintenance],
  ] as const) {
    const { rows } = await checked.query<{ superuser: boolean; bypass: boolean }>(
      'SELECT rolsuper AS superuser, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user',
    );
    if (rows[0]?.superuser !== false || rows[0]?.bypass !== false) {
      throw new Error(`роль ${role} обходит RLS: проверки изоляции под ней ничего не доказали бы`);
    }
  }
  return {
    roles,
    urls,
    admin: pool('admin', 4),
    app,
    appDb: drizzle(app),
    maintenance,
    maintenanceDb: drizzle(maintenance),
    reader: pool('reader', 4),
    pool,
    extraRole: async (label, attributes = '') => {
      const role = `scope_${label}_${suffix}`;
      const creator = new Client({ connectionString: PG_TEST_URL });
      await creator.connect();
      try {
        await creator.query(`CREATE ROLE ${role} LOGIN PASSWORD 'app' ${attributes}`);
      } finally {
        await creator.end();
      }
      extraRoles.push(role);
      const created = new Pool({ connectionString: urlFor(base, name, role), max: 2 });
      pools.push(created);
      return { role, pool: created };
    },
    drop: async () => {
      await Promise.all(pools.map((created) => created.end().catch(() => undefined)));
      const cleanup = new Client({ connectionString: PG_TEST_URL });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        for (const role of [...extraRoles, ...Object.values(roles)]) {
          await cleanup.query(`DROP ROLE IF EXISTS ${role}`);
        }
      } finally {
        await cleanup.end();
      }
    },
  };
};
