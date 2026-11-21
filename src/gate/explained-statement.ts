import { MIGRATION_STATEMENT } from '../constants/migration-statement.constant';
import type { SqlStatement } from '../types/sql-statement.type';

/**
 * Оператор, который сервер ИСПОЛНИТ: `EXPLAIN ANALYZE <оператор>` исполняет
 * оператор (CREATE TABLE … AS, CREATE MATERIALIZED VIEW — создаются), просто
 * `EXPLAIN` — только строит план (null: судить нечего). Параметр ANALYZE с
 * значением, которое не разобрать, — исполняет (не определить = строже).
 */
export function explainedStatement(statement: SqlStatement): SqlStatement | null {
  const explain = MIGRATION_STATEMENT.explain.exec(statement.masked);
  if (explain === null) {
    return statement;
  }
  const analyze =
    /\bANALY[SZ]E\b/i.test(explain[2] ?? '') ||
    (explain[1] ?? '').split(',').some((option) => {
      const [name, value] = option.trim().split(/\s+/);
      return /^ANALY[SZ]E$/i.test(name ?? '') && !/^(?:false|off|0|no)$/i.test(value ?? 'true');
    });
  if (!analyze) {
    return null;
  }
  const masked = explain[3] ?? '';
  return { masked, text: MIGRATION_STATEMENT.explain.exec(statement.text)?.[3] ?? masked };
}
