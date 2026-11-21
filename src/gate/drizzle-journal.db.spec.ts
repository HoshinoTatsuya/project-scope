import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { scopePolicySql } from '../policy/scope-policy-sql';
import { defineProjectScope } from '../scope/define-project-scope';
import { describeDb } from '../testing/describe-db';
import { createScopeTestDatabase } from '../testing/scope-test-database';
import type { ScopeTestDatabase } from '../testing/scope-test-database.type';
import { readMigrationFiles } from './read-migration-files';

/**
 * Журнал drizzle-kit, у которого `when` не растёт (ветки слиты, время
 * поправлено руками): НАСТОЯЩИЙ мигратор drizzle-orm на существующей базе
 * применяет только записи с `when` больше последнего применённого — и
 * «исправление» пропускается молча. Гейт, прочитавший все файлы журнала,
 * судил бы схему, которой в базе нет, — поэтому такой журнал — отказ.
 */
describeDb(
  'журнал drizzle: when не растёт — мигратор пропускает запись, гейт отказывает [нужен PG_TEST_URL]',
  () => {
    let database: ScopeTestDatabase;
    let dir: string;

    beforeAll(async () => {
      database = await createScopeTestDatabase();
      dir = mkdtempSync(join(tmpdir(), 'project-scope-drizzle-journal-'));
    });
    afterAll(async () => {
      rmSync(dir, { recursive: true, force: true });
      await database?.drop();
    });

    it('мигратор drizzle-orm применяет 2 из 3, представление остаётся без security_invoker; readMigrationFiles — отказ', async () => {
      const scope = defineProjectScope({
        setting: 'app.project_id',
        column: 'project_id',
        columnType: SCOPE_COLUMN_TYPE.uuid,
        tables: ['documents'],
      });
      mkdirSync(join(dir, 'meta'));
      const journal = (entries: [string, number][]): void =>
        writeFileSync(
          join(dir, 'meta', '_journal.json'),
          JSON.stringify({
            version: '7',
            dialect: 'postgresql',
            entries: entries.map(([tag, when], idx) => ({ idx, version: '7', when, tag, breakpoints: true })),
          }),
        );
      writeFileSync(
        join(dir, '0000_init.sql'),
        `CREATE TABLE documents (id uuid PRIMARY KEY, project_id uuid NOT NULL, body text);\n--> statement-breakpoint\n${scopePolicySql(scope)}`,
      );
      writeFileSync(join(dir, '0001_view.sql'), 'CREATE VIEW documents_v AS SELECT * FROM documents;');
      writeFileSync(
        join(dir, '0002_fix.sql'),
        'CREATE OR REPLACE VIEW documents_v WITH (security_invoker = true) AS SELECT * FROM documents;',
      );
      const db = drizzle(database.app);
      journal([
        ['0000_init', 1000],
        ['0001_view', 3000],
      ]);
      await migrate(db, { migrationsFolder: dir });
      journal([
        ['0000_init', 1000],
        ['0001_view', 3000],
        ['0002_fix', 2000],
      ]);
      await migrate(db, { migrationsFolder: dir });
      const applied = await database.app.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
      );
      const options = await database.app.query<{ options: string | null }>(
        "SELECT reloptions::text AS options FROM pg_class WHERE relname = 'documents_v'",
      );
      expect({ applied: applied.rows[0]?.n, options: options.rows[0]?.options }).toEqual({
        applied: 2,
        options: null,
      });
      expect(() => readMigrationFiles(dir)).toThrow(
        '0001_view.sql, 0002_fix.sql — when 2000 не больше 3000 у предыдущей записи журнала',
      );
    });
  },
);
