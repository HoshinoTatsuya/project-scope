import { describeDb } from '../testing/describe-db';
import { createScopeTestDatabase } from '../testing/scope-test-database';
import type { ScopeTestDatabase } from '../testing/scope-test-database.type';
import { splitSqlStatements } from './split-sql-statements';

/**
 * Что гейт миграций читает о границах операторов и секциях — так ли делает
 * сервер. Каждая проверка исполняет тот же текст, что разбирает гейт, на
 * настоящем Postgres: разбор, расходящийся с сервером, судил бы не то, что
 * применится.
 */
describeDb('гейт миграций против сервера: тела BEGIN ATOMIC и секции [нужен PG_TEST_URL]', () => {
  let database: ScopeTestDatabase;

  beforeAll(async () => {
    database = await createScopeTestDatabase();
  });
  afterAll(async () => {
    await database?.drop();
  });

  const run = (sql: string) => database.app.query(sql);

  it('сервер исполняет тело BEGIN ATOMIC … END одним оператором — столько операторов, сколько видит разбор', async () => {
    const sql = `
      CREATE TABLE oracle_items (id int, project_id uuid);
      CREATE FUNCTION oracle_f() RETURNS bigint LANGUAGE sql SECURITY DEFINER
      BEGIN ATOMIC
        SELECT 1;
        SELECT CASE WHEN true THEN count(*) END FROM oracle_items;
      END;
      CREATE OR REPLACE PROCEDURE oracle_p() BEGIN ATOMIC DELETE FROM oracle_items; END;
      CREATE FUNCTION begin() RETURNS int LANGUAGE sql RETURN 1;
      CREATE TYPE atomic AS (x int);
      CREATE FUNCTION oracle_k(begin atomic) RETURNS int LANGUAGE sql RETURN 1;
      CREATE TABLE oracle_after (id int);
    `;
    expect(splitSqlStatements(sql)).toHaveLength(7);
    // Каждый оператор разбора — целый оператор сервера: исполняется по одному.
    for (const statement of splitSqlStatements(sql)) {
      await run(statement.text);
    }
    const { rows } = await run(
      `SELECT (SELECT count(*)::int FROM pg_proc WHERE proname IN ('oracle_f', 'oracle_p', 'begin', 'oracle_k')) AS routines,
              to_regclass('oracle_after') IS NOT NULL AS after`,
    );
    expect(rows[0]).toEqual({ routines: 4, after: true });
  });

  it('секции на сервере: RENAME и SET SCHEMA оставляют секцию секцией; DETACH делает самостоятельной; DROP родителя уносит секции; ALTER TABLE переименует представление', async () => {
    await run(`
      CREATE SCHEMA oracle_archive;
      CREATE TABLE oracle_parent (id int, project_id uuid NOT NULL) PARTITION BY HASH (project_id);
      CREATE TABLE oracle_p0 PARTITION OF oracle_parent FOR VALUES WITH (MODULUS 2, REMAINDER 0);
      CREATE TABLE oracle_p1 PARTITION OF oracle_parent FOR VALUES WITH (MODULUS 2, REMAINDER 1);
      ALTER TABLE oracle_p0 RENAME TO oracle_part0;
      ALTER TABLE oracle_part0 SET SCHEMA oracle_archive;
      ALTER TABLE oracle_parent RENAME TO oracle_parent2;
      CREATE VIEW oracle_v AS SELECT 1 AS x;
      ALTER TABLE oracle_v RENAME TO oracle_view;
    `);
    const parentOf = async (child: string): Promise<string | null> =>
      (
        await run(
          `SELECT (SELECT inhparent::regclass::text FROM pg_inherits WHERE inhrelid = to_regclass('${child}')) AS parent`,
        )
      ).rows[0]?.parent ?? null;
    expect(await parentOf('oracle_archive.oracle_part0')).toBe('oracle_parent2');
    await run('ALTER TABLE oracle_parent2 DETACH PARTITION oracle_archive.oracle_part0');
    expect(await parentOf('oracle_archive.oracle_part0')).toBeNull();
    await run('DROP TABLE oracle_parent2');
    const { rows } = await run(
      `SELECT to_regclass('oracle_p1') IS NULL AS p1_dropped,
              to_regclass('oracle_archive.oracle_part0') IS NOT NULL AS detached_kept,
              (SELECT relkind::text FROM pg_class WHERE oid = to_regclass('oracle_view')) AS view_kind`,
    );
    expect(rows[0]).toEqual({ p1_dropped: true, detached_kept: true, view_kind: 'v' });
  });
});
