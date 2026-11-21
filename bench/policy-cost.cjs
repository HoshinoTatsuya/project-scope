'use strict';
/**
 * Цена политики области на чтении: таблица 1 000 000 строк (1000 областей по
 * 1000 строк), индекс по колонке области. Замер ДО политики (роль приложения,
 * RLS выключен) и ПОСЛЕ (`scopePolicySql`, контекст на транзакцию) — план и
 * время исполнения сервера (`EXPLAIN (ANALYZE)`), медиана и p95 по 300 запросам
 * со случайной областью.
 *
 * Запуск: `pnpm build && scripts/with-postgres.sh node bench/policy-cost.cjs`
 * (нужен PG_TEST_URL суперпользователя: база и роль создаются и удаляются).
 */
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { defineProjectScope, scopePolicySql, SCOPE_COLUMN_TYPE } = require('../dist');

const ROWS = 1_000_000;
const SCOPES = 1_000;
const RUNS = 300;

const adminUrl = process.env.PG_TEST_URL;
if (!adminUrl) {
  throw new Error('нужен PG_TEST_URL');
}

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

const planNodes = (plan) => [
  `${plan['Node Type']}${plan['Index Name'] ? ` ${plan['Index Name']}` : ''}`,
  ...(plan.Plans ?? []).flatMap(planNodes),
];

async function measure(client, label, text, params, setup) {
  const times = [];
  let nodes = [];
  let rows = -1;
  for (let run = 0; run < RUNS; run += 1) {
    const projectId = params(run);
    await client.query('BEGIN');
    if (setup) {
      await client.query("SELECT set_config('app.project_id', $1, true)", [projectId]);
    }
    const { rows: explained } = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, text.includes('$1') ? [projectId] : []);
    await client.query('COMMIT');
    const [report] = explained[0]['QUERY PLAN'];
    times.push(report['Execution Time']);
    nodes = planNodes(report.Plan);
    rows = report.Plan['Actual Rows'];
  }
  const line = {
    label,
    plan: nodes.join(' → '),
    rows,
    medianMs: Number(quantile(times, 0.5).toFixed(3)),
    p95Ms: Number(quantile(times, 0.95).toFixed(3)),
  };
  console.log(JSON.stringify(line));
  return line;
}

async function main() {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const name = `bench_${suffix}`;
  const role = `bench_app_${suffix}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`CREATE DATABASE ${name} OWNER ${role}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  url.username = role;
  url.password = 'app';
  const app = new Client({ connectionString: url.toString() });
  await app.connect();
  try {
    const { rows: version } = await app.query('SHOW server_version');
    console.log(JSON.stringify({ server: version[0].server_version, rows: ROWS, scopes: SCOPES, runs: RUNS }));
    await app.query(`
      CREATE TABLE items (id bigserial PRIMARY KEY, project_id uuid NOT NULL, body text NOT NULL);
      CREATE TABLE projects AS
        SELECT n, (lpad(to_hex(n), 8, '0') || '-0000-4000-8000-000000000000')::uuid AS id FROM generate_series(1, ${SCOPES}) n;
      INSERT INTO items (project_id, body)
        SELECT p.id, md5(g::text) FROM generate_series(1, ${ROWS}) g JOIN projects p ON p.n = 1 + (g % ${SCOPES});
      CREATE INDEX items_project_id ON items (project_id);
      ANALYZE items;
    `);
    const { rows: projects } = await app.query('SELECT id::text AS id FROM projects ORDER BY n');
    const pick = (run) => projects[(run * 7919) % projects.length].id;

    console.log('--- до: RLS выключен, фильтр в запросе');
    await measure(app, 'count, WHERE', 'SELECT count(*) FROM items WHERE project_id = $1', pick);
    await measure(app, 'page 50, WHERE', 'SELECT * FROM items WHERE project_id = $1 ORDER BY id LIMIT 50', pick);

    const scope = defineProjectScope({
      setting: 'app.project_id',
      column: 'project_id',
      columnType: SCOPE_COLUMN_TYPE.uuid,
      tables: ['items'],
    });
    await app.query(scopePolicySql(scope));

    console.log('--- после: политика области, контекст на транзакцию');
    await measure(app, 'count, WHERE + политика', "SELECT count(*) FROM items WHERE project_id = current_setting('app.project_id')::uuid", pick, true);
    await measure(app, 'count, БЕЗ WHERE (забыт)', 'SELECT count(*) FROM items', pick, true);
    await measure(app, 'page 50, БЕЗ WHERE (забыт)', 'SELECT * FROM items ORDER BY id LIMIT 50', pick, true);
    await measure(app, 'count, БЕЗ контекста', 'SELECT count(*) FROM items', () => '', false);
  } finally {
    await app.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
