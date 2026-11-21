import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  integer,
  pgMaterializedView,
  pgSchema,
  pgTable,
  pgView,
  serial,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

import { SCOPE_COLUMN_TYPE } from '../constants/scope-column-type.constant';
import { defineProjectScope } from '../scope/define-project-scope';
import { schemaScopeViolations } from './schema-scope-violations';

const audit = pgSchema('audit');

/** Схема проекта: имя поля и имя колонки в базе различаются — сравнивается имя в базе. */
const schema = {
  items: pgTable('items', { id: serial('id').primaryKey(), projectId: uuid('project_id').notNull() }),
  events: audit.table('events', { id: serial('id'), projectId: uuid('project_id') }),
  plain: pgTable('plain', { id: serial('id'), body: text('body') }),
  // Поле называется как колонка области, а колонка в базе — нет.
  decoy: pgTable('decoy', { project_id: integer('owner_project') }),
  notATable: { project_id: 'x' },
};

const scopeOf = (tables: string[]) =>
  defineProjectScope({
    setting: 'app.project_id',
    column: 'project_id',
    columnType: SCOPE_COLUMN_TYPE.uuid,
    tables,
  });

describe('schemaScopeViolations', () => {
  it('каждая таблица с колонкой области в списке — чисто; выборка — все таблицы схемы', () => {
    expect(schemaScopeViolations(scopeOf(['items', 'audit.events']), schema)).toEqual({
      violations: [],
      tables: ['audit.events', 'decoy', 'items', 'plain'],
      scopedTables: ['audit.events', 'items'],
      usedNotScoped: [],
    });
  });

  it('таблица с колонкой области вне списка — нарушение (новая таблица не выпадает молча)', () => {
    expect(schemaScopeViolations(scopeOf(['items']), schema).violations).toEqual([
      'схема: audit.events с колонкой project_id не в списке области — защита её не касается',
    ]);
  });

  it('таблица списка без колонки или вне схемы — нарушение; массив модулей и повтор таблицы', () => {
    expect(
      schemaScopeViolations(scopeOf(['items', 'audit.events', 'plain', 'gone']), [
        schema,
        { again: schema.items },
      ]).violations,
    ).toEqual([
      'схема: gone в списке области, а в схеме её нет',
      'схема: plain в списке области, а колонки project_id в ней нет',
    ]);
    expect(() => schemaScopeViolations(scopeOf(['items']), null)).toThrow('объект экспортов');
  });

  it('casing базы: поле без явного имени сравнивается по имени, которое уйдёт в SQL', () => {
    const documents = pgTable('documents', { id: serial().primaryKey(), projectId: uuid().notNull() });
    const leak = pgTable('leak', { id: serial().primaryKey(), projectId: uuid().notNull() });
    // То же имя, что drizzle с этим casing пишет в SQL.
    expect(drizzle.mock({ casing: 'snake_case' }).select().from(leak).toSQL().sql).toBe(
      'select "id", "project_id" from "leak"',
    );
    expect(
      schemaScopeViolations(scopeOf(['documents']), { documents, leak }, { casing: 'snake_case' }),
    ).toEqual({
      violations: ['схема: leak с колонкой project_id не в списке области — защита её не касается'],
      tables: ['documents', 'leak'],
      scopedTables: ['documents', 'leak'],
      usedNotScoped: [],
    });
    // Без casing имя в базе — ключ поля; но гейт не молчит о том, что это решает casing.
    expect(schemaScopeViolations(scopeOf(['documents']), { documents }).violations).toEqual([
      'схема: documents в списке области, а колонки project_id в ней нет',
      'схема: поле projectId без явного имени — колонкой project_id в базе оно становится только при casing базы drizzle; передайте гейту casing (или задайте имя колонки явно)',
    ]);
    // camelCase-база: колонка области в базе — projectId, а не project_id.
    const camel = pgTable('camel', { id: serial().primaryKey(), project_id: uuid().notNull() });
    expect(
      schemaScopeViolations(scopeOf(['documents']), { documents, camel }, { casing: 'camelCase' })
        .scopedTables,
    ).toEqual([]);
  });

  it('материализованное представление с колонкой области — нарушение; представление — только без securityInvoker', () => {
    const items = schema.items;
    const views = {
      itemsMv: pgMaterializedView('items_mv').as((qb) => qb.select().from(items)),
      itemsOwner: pgView('items_owner').as((qb) => qb.select().from(items)),
      itemsInvoker: pgView('items_invoker')
        .with({ securityInvoker: true })
        .as((qb) => qb.select().from(items)),
      plainView: pgView('plain_view').as((qb) => qb.select().from(schema.plain)),
      existing: pgView('legacy', { projectId: uuid('project_id') }).existing(),
    };
    expect(
      schemaScopeViolations(scopeOf(['items', 'audit.events']), { ...schema, ...views }).violations,
    ).toEqual([
      'схема: материализованное представление items_mv с колонкой project_id — у него нет RLS, REFRESH выносит строки всем',
      'схема: представление items_owner с колонкой project_id без .with({ securityInvoker: true }) — политики применялись бы к его владельцу',
    ]);
  });

  it('представление, чей запрос читает таблицу области без колонки в выборке (агрегат), — нарушение; двойники — чисто', () => {
    const { items, plain } = schema;
    const views = {
      total: pgView('items_total').as((qb) => qb.select({ n: sql<number>`count(*)`.as('n') }).from(items)),
      totalMv: pgMaterializedView('items_total_mv').as((qb) =>
        qb.select({ n: sql<number>`count(*)`.as('n') }).from(items),
      ),
      raw: pgView('items_raw', { n: integer('n') }).as(sql`select count(*) as n from items`),
      rawRef: pgView('items_raw_ref', { n: integer('n') }).as(sql`select count(*) as n from ${items}`),
      // Таблица области — только в условии.
      filtered: pgView('plain_filtered').as((qb) =>
        qb
          .select({ body: plain.body })
          .from(plain)
          .where(sql`exists (select 1 from ${items} where ${items.id} = ${plain.id})`),
      ),
      // Таблица области — только в подзапросе.
      sub: pgView('items_sub').as((qb) => {
        const ids = qb.select({ id: items.id }).from(items).as('ids');
        return qb.select({ n: sql<number>`count(*)`.as('n') }).from(ids);
      }),
      // Представление над представлением с securityInvoker: внешнее — правами своего владельца.
      outer: pgView('items_outer', { n: integer('n') }).as(sql`select n from items_total_invoker`),
      inner: pgView('items_total_invoker')
        .with({ securityInvoker: true })
        .as((qb) => qb.select({ n: sql<number>`count(*)`.as('n') }).from(items)),
      // Двойники.
      plainTotal: pgView('plain_total').as((qb) =>
        qb.select({ n: sql<number>`count(*)`.as('n') }).from(plain),
      ),
      invoker: pgView('items_total_inv2')
        .with({ securityInvoker: true })
        .as((qb) => qb.select({ n: sql<number>`count(*)`.as('n') }).from(items)),
    };
    expect(
      schemaScopeViolations(scopeOf(['items', 'audit.events']), { ...schema, ...views }).violations,
    ).toEqual([
      'схема: материализованное представление items_total_mv над таблицей области items (читает её запрос) — у него нет RLS, REFRESH выносит строки всем',
      'схема: представление items_outer над таблицей области items (читает её запрос) без .with({ securityInvoker: true }) — политики применялись бы к его владельцу',
      'схема: представление items_raw над таблицей области items (читает её запрос) без .with({ securityInvoker: true }) — политики применялись бы к его владельцу',
      'схема: представление items_raw_ref над таблицей области items (читает её запрос) без .with({ securityInvoker: true }) — политики применялись бы к его владельцу',
      'схема: представление items_sub над таблицей области items (читает её запрос) без .with({ securityInvoker: true }) — политики применялись бы к его владельцу',
      'схема: представление items_total над таблицей области items (читает её запрос) без .with({ securityInvoker: true }) — политики применялись бы к его владельцу',
      'схема: представление plain_filtered над таблицей области items (читает её запрос) без .with({ securityInvoker: true }) — политики применялись бы к его владельцу',
    ]);
  });

  it('notScoped: представление с причиной гейт схемы не судит и сообщает, что запись понадобилась', () => {
    const itemsMv = pgMaterializedView('items_mv', { projectId: uuid('project_id') }).existing();
    const report = schemaScopeViolations(
      scopeOf(['items', 'audit.events']),
      { ...schema, itemsMv },
      { notScoped: { items_mv: 'агрегат читает только роль сквозного доступа' } },
    );
    expect(report.violations).toEqual([]);
    expect(report.usedNotScoped).toEqual(['items_mv']);
    // Двойник: без записи то же представление — нарушение.
    expect(
      schemaScopeViolations(scopeOf(['items', 'audit.events']), { ...schema, itemsMv }).violations,
    ).toHaveLength(1);
  });

  it('notScoped при прямом вызове: короткая причина (и из невидимых знаков) и ненужная запись — нарушения; двойник — чисто', () => {
    const itemsMv = pgMaterializedView('items_mv', { projectId: uuid('project_id') }).existing();
    const judged = (notScoped: Record<string, string>) =>
      schemaScopeViolations(scopeOf(['items', 'audit.events']), { ...schema, itemsMv }, { notScoped })
        .violations;
    expect(judged({ items_mv: 'агрегат читает только роль сквозного доступа' })).toEqual([]);
    expect(judged({ items_mv: 'legacy' })).toEqual([
      'допущение items_mv: причина короче 20 символов — объясните, почему',
    ]);
    // Пробелы нулевой ширины и заполнитель U+3164 порог не набирают.
    expect(judged({ items_mv: `ok${'\u200b'.repeat(20)}${'\u3164'.repeat(5)}` })).toEqual([
      'допущение items_mv: причина короче 20 символов — объясните, почему',
    ]);
    expect(
      judged({
        items_mv: 'агрегат читает только роль сквозного доступа',
        gone: 'таблица давно удалена из схемы проекта',
      }),
    ).toEqual(['notScoped.gone: не понадобилось — уберите запись']);
  });
});
