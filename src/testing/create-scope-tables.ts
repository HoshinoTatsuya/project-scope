import { scopePolicySql } from '../policy/scope-policy-sql';
import type { ProjectScope } from '../types/project-scope.type';
import { PROJECT } from './project.constant';
import type { ScopeTestDatabase } from './scope-test-database.type';

/**
 * Таблицы `items` и `notes` (uuid-область) — создаёт РОЛЬ ПРИЛОЖЕНИЯ, то есть
 * она их владелец; защита — `scopePolicySql`. Строки — суперпользователем (он
 * обходит RLS): по две строки области A, одна — B.
 */
export const createScopeTables = async (
  database: ScopeTestDatabase,
  scope: ProjectScope,
  policySql: string = scopePolicySql(scope),
): Promise<void> => {
  await database.app.query(`
    CREATE TABLE items (id serial PRIMARY KEY, project_id uuid NOT NULL, body text NOT NULL);
    CREATE INDEX items_project_id ON items (project_id);
    CREATE TABLE notes (id serial PRIMARY KEY, project_id uuid NOT NULL, body text NOT NULL);
    ${policySql}
    GRANT SELECT, INSERT, UPDATE, DELETE ON items, notes TO ${database.roles.maintenance}, ${database.roles.reader};
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${database.roles.maintenance}, ${database.roles.reader};
  `);
  await database.admin.query(
    `INSERT INTO items (project_id, body) VALUES ($1, 'a.1'), ($1, 'a.2'), ($2, 'b.1')`,
    [PROJECT.a, PROJECT.b],
  );
  await database.admin.query(`INSERT INTO notes (project_id, body) VALUES ($1, 'a.note'), ($2, 'b.note')`, [
    PROJECT.a,
    PROJECT.b,
  ]);
};
