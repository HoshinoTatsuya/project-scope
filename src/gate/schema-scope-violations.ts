import { is, SQL, StringChunk, Subquery, View } from 'drizzle-orm';
import { CasingCache, toCamelCase, toSnakeCase } from 'drizzle-orm/casing';
import {
  getMaterializedViewConfig,
  getTableConfig,
  getViewConfig,
  PgColumn,
  PgMaterializedView,
  PgTable,
  PgView,
} from 'drizzle-orm/pg-core';

import { SQL_NAME_PATTERN } from '../constants/sql-name-pattern.constant';
import type { ProjectScope } from '../types/project-scope.type';
import type { SchemaScopeOptions } from '../types/schema-scope-options.type';
import type { SchemaScopeReport } from '../types/schema-scope-report.type';
import { allowanceProblems } from './allowance-problems';
import { sqlObjectName } from './sql-object-name';

/**
 * Таблицы и представления drizzle-схемы против списка области:
 * - каждая таблица с колонкой области (по ИМЕНИ В БАЗЕ — с учётом `casing`
 *   базы drizzle, а не по ключу поля) обязана быть в списке — иначе новая
 *   таблица выпадает из защиты молча; каждая таблица списка — в схеме с этой
 *   колонкой, иначе список устарел;
 * - материализованное представление над данными области — нарушение: у него
 *   нет RLS, и REFRESH сохраняет строки, видимые обновившему, для всех;
 * - представление над данными области без `.with({ securityInvoker: true })` —
 *   нарушение: политики применялись бы к его владельцу. «Над данными области» —
 *   колонка области в выборке ИЛИ запрос представления читает таблицу области
 *   (или представление над ней): `SELECT count(*) FROM items` колонки не
 *   выводит, а агрегирует строки всех областей — как в гейте миграций.
 *   Запрос читается по объектам drizzle (таблицы, подзапросы,
 *   представления) и по тексту `sql` (имена таблиц области). Представление
 *   `.existing()` описывает объект вне миграций drizzle — его параметры
 *   проверяет `assertScopeReady` по каталогу;
 * - представление из `notScoped` (с причиной) не судится — как в гейте миграций;
 *   причина короче порога (по видимым знакам) и запись, которая схеме не
 *   понадобилась, — нарушения, как там же (покрытие сводит оба отчёта);
 * - поле без явного имени, которое колонкой области становится только при
 *   `casing` базы, при не переданном `casing` — нарушение: «не знаю, какое имя
 *   уйдёт в SQL» — не «колонки нет».
 *
 * `schema` — экспорт модуля схемы (объект) или их массив. `is` и
 * `getTableConfig` drizzle опознают таблицы и чужой копии drizzle-orm.
 */
export function schemaScopeViolations(
  scope: ProjectScope,
  schema: unknown,
  options: SchemaScopeOptions = {},
): SchemaScopeReport {
  const casing = new CasingCache(options.casing);
  const ambiguous = new Set<string>();
  const columnNames = (columns: readonly unknown[]): string[] =>
    columns
      .filter((column): column is PgColumn => is(column, PgColumn))
      .map((column) => {
        const name = casing.getColumnCasing(column);
        // Поле без явного имени, которое при casing базы стало бы колонкой области:
        // какое имя уйдёт в SQL, решает casing, которого гейту не передали.
        if (
          options.casing === undefined &&
          column.keyAsName &&
          name !== scope.column &&
          (toSnakeCase(name) === scope.column || toCamelCase(name) === scope.column)
        ) {
          ambiguous.add(name);
        }
        return name;
      });
  const qualified = (schemaName: string | undefined, name: string): string =>
    schemaName === undefined || schemaName === 'public' ? name : `${schemaName}.${name}`;
  const modules = Array.isArray(schema) ? schema : [schema];
  const seen = new Set<unknown>();
  const tables = new Map<string, boolean>();
  const views: unknown[] = [];
  const derived: string[] = [];
  const usedNotScoped = new Set<string>();
  for (const module of modules) {
    if (typeof module !== 'object' || module === null) {
      throw new Error('schemaScopeViolations: schema — объект экспортов модуля схемы или их массив');
    }
    for (const value of Object.values(module)) {
      if (seen.has(value)) {
        continue;
      }
      seen.add(value);
      if (is(value, PgTable)) {
        const config = getTableConfig(value);
        tables.set(qualified(config.schema, config.name), columnNames(config.columns).includes(scope.column));
      } else if (is(value, PgMaterializedView) || is(value, PgView)) {
        // Представления — после таблиц: запрос судится по таблицам всей схемы.
        views.push(value);
      }
    }
  }
  const viewConfig = (view: unknown) =>
    is(view, PgMaterializedView) ? getMaterializedViewConfig(view) : getViewConfig(view as PgView);
  const viewsByName = new Map(
    views.map((view) => {
      const config = viewConfig(view);
      return [qualified(config.schema, config.name), view] as const;
    }),
  );
  const isScopeTable = (name: string): boolean => tables.get(name) === true || scope.tables.includes(name);
  const anyName = new RegExp(SQL_NAME_PATTERN.qualified, 'g');
  /** Таблица области, которую читает запрос представления (или null). */
  const reads = new Map<unknown, string | null>();
  const scopeTableRead = (node: unknown, depth = 0): string | null => {
    if (node === null || node === undefined || depth > 64) {
      return null;
    }
    if (is(node, PgTable)) {
      const config = getTableConfig(node);
      const name = qualified(config.schema, config.name);
      return isScopeTable(name) ? name : null;
    }
    if (is(node, StringChunk)) {
      // Текст запроса: таблица области или представление схемы над ней — по имени.
      for (const name of (node.value.join(' ').match(anyName) ?? []).map(sqlObjectName)) {
        const found = isScopeTable(name) ? name : scopeTableRead(viewsByName.get(name), depth + 1);
        if (found !== null) {
          return found;
        }
      }
      return null;
    }
    if (is(node, SQL)) {
      for (const chunk of node.queryChunks) {
        const found = scopeTableRead(chunk, depth + 1);
        if (found !== null) {
          return found;
        }
      }
      return null;
    }
    if (is(node, Subquery)) {
      return scopeTableRead((node as unknown as { _: { sql: unknown } })._.sql, depth + 1);
    }
    if (is(node, View)) {
      // Представление над представлением: читает то же, что внутреннее.
      if (!reads.has(node)) {
        reads.set(node, null);
        reads.set(node, scopeTableRead(viewConfig(node).query, depth + 1));
      }
      return reads.get(node) ?? null;
    }
    return null;
  };
  for (const view of views) {
    const config = viewConfig(view);
    const name = qualified(config.schema, config.name);
    const materialized = is(view, PgMaterializedView);
    const existing = !materialized && (config as { isExisting?: boolean }).isExisting === true;
    const invoker =
      !materialized && (config as { with?: { securityInvoker?: boolean } }).with?.securityInvoker === true;
    if (Object.hasOwn(options.notScoped ?? {}, name)) {
      usedNotScoped.add(name);
      continue;
    }
    if (existing || invoker) {
      continue;
    }
    const withColumn = columnNames(Object.values(config.selectedFields)).includes(scope.column);
    const read = withColumn ? null : scopeTableRead(view);
    if (!withColumn && read === null) {
      continue;
    }
    const over = withColumn
      ? `с колонкой ${scope.column}`
      : `над таблицей области ${read} (читает её запрос)`;
    derived.push(
      materialized
        ? `схема: материализованное представление ${name} ${over} — у него нет RLS, REFRESH выносит строки всем`
        : `схема: представление ${name} ${over} без .with({ securityInvoker: true }) — политики применялись бы к его владельцу`,
    );
  }
  const scopedTables = [...tables].filter(([, scoped]) => scoped).map(([name]) => name);
  // Допущения — как в гейте миграций: причина не короче порога, лишняя запись — нарушение.
  const allowances = allowanceProblems('notScoped', options.notScoped ?? {}, usedNotScoped);
  const violations = [
    ...scopedTables
      .filter((table) => !scope.tables.includes(table))
      .map(
        (table) => `схема: ${table} с колонкой ${scope.column} не в списке области — защита её не касается`,
      ),
    ...scope.tables
      .filter((table) => tables.get(table) !== true)
      .map((table) =>
        tables.has(table)
          ? `схема: ${table} в списке области, а колонки ${scope.column} в ней нет`
          : `схема: ${table} в списке области, а в схеме её нет`,
      ),
    ...derived.sort(),
    ...[...ambiguous]
      .sort()
      .map(
        (field) =>
          `схема: поле ${field} без явного имени — колонкой ${scope.column} в базе оно становится только при casing базы drizzle; передайте гейту casing (или задайте имя колонки явно)`,
      ),
    ...allowances.reasons,
    ...allowances.unused,
  ];
  return {
    violations,
    tables: [...tables.keys()].sort(),
    scopedTables: scopedTables.sort(),
    usedNotScoped: [...usedNotScoped].sort(),
  };
}
