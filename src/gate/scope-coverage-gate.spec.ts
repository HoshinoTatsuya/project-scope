import { join } from 'node:path';

import { pgMaterializedView, pgTable, serial, text, uuid } from 'drizzle-orm/pg-core';

import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { defineProjectScope } from '../scope/define-project-scope';
import { evaluateScopeCoverage } from './evaluate-scope-coverage';
import { readMigrationFiles } from './read-migration-files';
import { scopeCoverageGate } from './scope-coverage-gate';

const MIGRATIONS = join(__dirname, '..', 'testing', 'coverage-fixture', 'migrations');

const schema = {
  items: pgTable('items', {
    id: serial('id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    body: text('body'),
  }),
  notes: pgTable('notes', { id: serial('id').primaryKey(), projectId: uuid('project_id').notNull() }),
  plain: pgTable('plain', { id: serial('id').primaryKey() }),
};

const scope = defineProjectScope({
  setting: 'app.project_id',
  column: 'project_id',
  columnType: SCOPE_COLUMN_TYPE.uuid,
  tables: ['items', 'notes'],
});

// Сам гейт — так, как его вызывает проект: два теста, оба обязаны быть зелёными.
scopeCoverageGate({ scope, schema, migrations: MIGRATIONS, minSchemaTables: 3, minMigrations: 2 });

describe('evaluateScopeCoverage', () => {
  it('миграции каталога drizzle-kit — по журналу meta/_journal.json', () => {
    expect(readMigrationFiles(MIGRATIONS).map((file) => file.name)).toEqual([
      '0000_init.sql',
      '0001_notes.sql',
    ]);
    expect(() => readMigrationFiles(join(MIGRATIONS, 'absent'))).toThrow('ENOENT');
  });

  it('отчёт: выборка и нарушения схемы и миграций вместе', () => {
    const narrow = defineProjectScope({
      setting: scope.setting,
      column: scope.column,
      columnType: scope.columnType,
      tables: ['items'],
    });
    const report = evaluateScopeCoverage({ scope: narrow, schema, migrations: MIGRATIONS });
    expect(report).toEqual({
      violations: [
        'схема: notes с колонкой project_id не в списке области — защита её не касается',
        'notes: колонка project_id есть, а в списке области таблицы нет',
      ],
      schemaTables: 3,
      migrations: 2,
      scopedInSchema: ['items', 'notes'],
      scopedInMigrations: ['items', 'notes'],
    });
  });

  it('пустые схема и миграции — нарушений ноль, но выборка нулевая (гейт краснеет на ней)', () => {
    expect(evaluateScopeCoverage({ scope, schema: {}, migrations: [] })).toEqual({
      violations: [
        'схема: items в списке области, а в схеме её нет',
        'схема: notes в списке области, а в схеме её нет',
        'items в списке области, а миграции её не создают',
        'notes в списке области, а миграции её не создают',
      ],
      schemaTables: 0,
      migrations: 0,
      scopedInSchema: [],
      scopedInMigrations: [],
    });
  });

  it('notScoped, понадобившийся только схеме (.existing()), миграциям «лишним» не считается; ненужный — нарушение', () => {
    const statsMv = pgMaterializedView('stats_mv', { projectId: uuid('project_id') }).existing();
    const reason = 'агрегат читает только роль сквозного доступа';
    expect(
      evaluateScopeCoverage({
        scope,
        schema: { ...schema, statsMv },
        migrations: MIGRATIONS,
        notScoped: { stats_mv: reason },
      }).violations,
    ).toEqual([]);
    expect(
      evaluateScopeCoverage({ scope, schema, migrations: MIGRATIONS, notScoped: { stats_mv: reason } })
        .violations,
    ).toEqual(['notScoped.stats_mv: не понадобилось — уберите запись']);
  });

  it('notScoped, понадобившийся только МИГРАЦИЯМ, схеме «лишним» не считается; короткая причина — одна запись, а не от каждого гейта', () => {
    const migrations = [
      ...readMigrationFiles(MIGRATIONS),
      { name: '0002_copy.sql', sql: 'CREATE TABLE copy AS SELECT * FROM plain;' },
    ];
    const reason = 'копия справочника без строк проектов';
    expect(
      evaluateScopeCoverage({ scope, schema, migrations, notScoped: { copy: reason } }).violations,
    ).toEqual([]);
    expect(
      evaluateScopeCoverage({ scope, schema, migrations, notScoped: { copy: '\u200b'.repeat(30) } })
        .violations,
    ).toEqual(['допущение copy: причина короче 20 символов — объясните, почему']);
  });
});
