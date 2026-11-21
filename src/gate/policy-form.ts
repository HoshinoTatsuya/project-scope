import type { PolicyForm } from '../types/policy-form.type';
import { parenthesizedBody } from './parenthesized-body';
import { policyTail } from './policy-tail';
import { sqlObjectName } from './sql-object-name';

/**
 * Предложения политики после `CREATE POLICY имя ON таблица` (или изменения
 * после `ALTER POLICY имя ON таблица`) — по ТЕКСТУ с литералами, по порядку
 * грамматики: `AS`, `FOR`, `TO`, `USING (…)`, `WITH CHECK (…)`. `base` —
 * прежняя форма для ALTER POLICY: не названное предложение остаётся прежним.
 * Текст, который разбор не понял целиком, — null: «не разобрал» не «та».
 */
export function policyForm(tail: string, base?: PolicyForm): PolicyForm | null {
  let rest = tail.trim();
  const take = (pattern: RegExp): RegExpExecArray | null => {
    const match = pattern.exec(rest);
    if (match !== null) {
      rest = rest.slice(match[0].length).trim();
    }
    return match;
  };
  const body = (keyword: RegExp): string | null | undefined => {
    if (take(keyword) === null) {
      return undefined;
    }
    const inner = parenthesizedBody(rest);
    if (inner === null) {
      return null;
    }
    rest = inner.rest;
    return policyTail(inner.body);
  };
  const as = take(/^AS (PERMISSIVE|RESTRICTIVE)\b/i)?.[1]?.toLowerCase();
  const command = take(/^FOR (ALL|SELECT|INSERT|UPDATE|DELETE)\b/i)?.[1]?.toLowerCase();
  const roles = take(/^TO (.+?)(?=\s+(?:USING|WITH CHECK)\b|$)/i)?.[1];
  const using = body(/^USING ?(?=\()/i);
  const check = body(/^WITH CHECK ?(?=\()/i);
  if (rest !== '' || using === null || check === null) {
    return null;
  }
  return {
    permissive: as === undefined ? (base?.permissive ?? true) : as === 'permissive',
    command: command ?? base?.command ?? 'all',
    roles:
      roles === undefined
        ? (base?.roles ?? [])
        : roles
            .split(',')
            .map((role) => sqlObjectName(role.trim()))
            .filter((role) => role !== ''),
    using: using === undefined ? (base?.using ?? null) : using,
    check: check === undefined ? (base?.check ?? null) : check,
  };
}
