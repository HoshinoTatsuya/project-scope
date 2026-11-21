import { SQL_NAME_PATTERN } from '../constants/sql-name-pattern.constant';
import { unicodeIdentifier } from './unicode-identifier';

/**
 * Имя так, как его хранит Postgres: простой идентификатор — в нижнем регистре,
 * в кавычках — как есть, юникодный `U&"…"` — раскрытым; схема public
 * опускается (так названы таблицы области).
 */
export function sqlObjectName(raw: string): string {
  const parts = (raw.match(new RegExp(SQL_NAME_PATTERN.identifier, 'g')) ?? []).map((part) => {
    if (/^[Uu]&"/.test(part)) {
      return unicodeIdentifier(part.slice(3, -1).replaceAll('""', '"'));
    }
    return part.startsWith('"') ? part.slice(1, -1).replaceAll('""', '"') : part.toLowerCase();
  });
  return parts.length === 2 && parts[0] === 'public' ? (parts[1] ?? '') : parts.join('.');
}
