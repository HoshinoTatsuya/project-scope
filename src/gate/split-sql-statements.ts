import type { SqlStatement } from '../types/sql-statement.type';

/**
 * Операторы SQL-текста по `;` верхнего уровня. Комментарии (`--` и вложенные
 * `/* *\/`) вырезаются — закомментированный `ENABLE ROW LEVEL SECURITY` не
 * включает ничего; в `masked` строки становятся `''`, а тела `$$…$$` —
 * `$body$`, чтобы `;` и слова внутри них не читались операторами. Пробелы
 * сведены к одному.
 *
 * Тело `BEGIN ATOMIC … END` функции и процедуры (SQL-стандарт, Postgres 14+)
 * — часть своего оператора: `;` внутри него оператор не заканчивают. Правило
 * — как у psql, но тело открывает пара слов `BEGIN ATOMIC`, а не любое `BEGIN`
 * (функция с именем `begin` у psql склеивала бы оператор с остатком файла): в
 * операторе, начатом `CREATE [OR REPLACE] FUNCTION | PROCEDURE`, вне скобок
 * `BEGIN ATOMIC` открывает тело, `CASE` внутри тела — блок до своего `END`,
 * `END` закрывает. Иначе тело делилось бы на куски: оператор `CREATE FUNCTION`
 * нёс бы только первый оператор тела, и таблица области во втором для разбора
 * не существовала бы.
 *
 * Незакрытая строка, идентификатор, тело или комментарий — исключение:
 * разбор, не понявший текст, не отвечает «операторов нет».
 */
export function splitSqlStatements(sql: string): SqlStatement[] {
  const identifierChar = /[\p{L}\p{N}_$]/u;
  const statements: SqlStatement[] = [];
  let text = '';
  let masked = '';
  // Начало оператора (первые слова) и глубина скобок и блоков BEGIN … END его тела.
  let leading: string[] = [];
  let previous = '';
  let parens = 0;
  let blocks = 0;
  const flush = (): void => {
    const statementMasked = masked.replace(/\s+/g, ' ').trim();
    if (statementMasked !== '') {
      statements.push({ text: text.replace(/\s+/g, ' ').trim(), masked: statementMasked });
    }
    text = '';
    masked = '';
    leading = [];
    previous = '';
    parens = 0;
    blocks = 0;
  };
  /** Оператор начат `CREATE [OR REPLACE] FUNCTION | PROCEDURE`. */
  const routine = (): boolean => {
    const [first, second, third, fourth] = leading;
    const kind = (word: string | undefined): boolean => word === 'function' || word === 'procedure';
    return first === 'create' && (kind(second) || (second === 'or' && third === 'replace' && kind(fourth)));
  };
  const closing = (from: number, quote: string, backslash: boolean): number => {
    let index = from;
    for (;;) {
      if (index >= sql.length) {
        throw new Error(`незакрытый литерал ${quote}…`);
      }
      if (backslash && sql[index] === '\\') {
        index += 2;
      } else if (sql[index] === quote && sql[index + 1] === quote) {
        index += 2;
      } else if (sql[index] === quote) {
        return index;
      } else {
        index += 1;
      }
    }
  };
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? '';
    const next = sql[index + 1];
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end + 1;
      text += ' ';
      masked += ' ';
    } else if (char === '/' && next === '*') {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < sql.length && depth > 0) {
        if (sql.startsWith('/*', cursor)) {
          depth += 1;
          cursor += 2;
        } else if (sql.startsWith('*/', cursor)) {
          depth -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (depth > 0) {
        throw new Error('незакрытый комментарий /*');
      }
      index = cursor;
      text += ' ';
      masked += ' ';
    } else if (char === "'") {
      const backslash = /[Ee]/.test(sql[index - 1] ?? '') && !identifierChar.test(sql[index - 2] ?? '');
      const end = closing(index + 1, "'", backslash);
      text += sql.slice(index, end + 1);
      masked += "''";
      index = end + 1;
    } else if (char === '"') {
      const end = closing(index + 1, '"', false);
      text += sql.slice(index, end + 1);
      masked += sql.slice(index, end + 1);
      index = end + 1;
    } else if (char === '$' && !identifierChar.test(sql[index - 1] ?? '')) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
      if (tag === undefined) {
        text += char;
        masked += char;
        index += 1;
      } else {
        const end = sql.indexOf(tag, index + tag.length);
        if (end === -1) {
          throw new Error(`незакрытое тело ${tag}`);
        }
        text += sql.slice(index, end + tag.length);
        masked += '$body$';
        index = end + tag.length;
      }
    } else if (/[\p{L}_]/u.test(char) && !identifierChar.test(sql[index - 1] ?? '')) {
      const word = /^[\p{L}_][\p{L}\p{N}_$]*/u.exec(sql.slice(index))?.[0] ?? char;
      const lower = word.toLowerCase();
      if (leading.length < 4) {
        leading.push(lower);
      }
      if (parens === 0 && routine()) {
        if (
          (lower === 'atomic' && previous === 'begin' && blocks === 0) ||
          (lower === 'case' && blocks > 0)
        ) {
          blocks += 1;
        } else if (lower === 'end' && blocks > 0) {
          blocks -= 1;
        }
      }
      previous = lower;
      text += word;
      masked += word;
      index += word.length;
    } else if (char === ';' && blocks === 0) {
      flush();
      index += 1;
    } else {
      if (char === '(') {
        parens += 1;
      } else if (char === ')' && parens > 0) {
        parens -= 1;
      }
      text += char;
      masked += char;
      index += 1;
    }
  }
  if (blocks > 0) {
    throw new Error('незакрытое тело BEGIN ATOMIC … END');
  }
  flush();
  return statements;
}
