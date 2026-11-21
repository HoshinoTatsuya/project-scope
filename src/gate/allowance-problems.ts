import { MIGRATION_SCOPE_LIMITS } from '../constants/migration-scope-limits.constant';
import { visibleLength } from '../scope/visible-length';

/**
 * Допущения гейтов (`notScoped`, `adoptedLater`): причина короче порога — по
 * видимым знакам: пробелы нулевой ширины и заполнители порог не набирают, —
 * и запись, которая не понадобилась (`used` — какие понадобились). Один текст
 * у обоих гейтов: покрытие сводит их отчёты и убирает повторы.
 */
export function allowanceProblems(
  kind: 'notScoped' | 'adoptedLater',
  entries: Readonly<Record<string, unknown>>,
  used: ReadonlySet<string> | null,
): { readonly reasons: string[]; readonly unused: string[] } {
  const reasons: string[] = [];
  const unused: string[] = [];
  for (const [name, reason] of Object.entries(entries)) {
    if (typeof reason !== 'string' || visibleLength(reason) < MIGRATION_SCOPE_LIMITS.MIN_REASON_LENGTH) {
      reasons.push(
        `допущение ${name}: причина короче ${MIGRATION_SCOPE_LIMITS.MIN_REASON_LENGTH} символов — объясните, почему`,
      );
    }
    if (used !== null && !used.has(name)) {
      unused.push(`${kind}.${name}: не понадобилось — уберите запись`);
    }
  }
  return { reasons, unused };
}
