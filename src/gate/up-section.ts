/**
 * Текст миграции dbmate, который применяется вперёд: секция между
 * `-- migrate:up` и `-- migrate:down` (маркеры — с начала строки, как их ищет
 * dbmate). Файл без маркера `-- migrate:up` с начала строки и файл, где до
 * него есть операторы, dbmate не применяет (отказ) — гейт тоже отказывает, а
 * не читает весь текст.
 */
export function upSection(name: string, sql: string): string {
  const up = /^--\s*migrate:up\b.*$/m.exec(sql);
  if (up === null) {
    throw new Error(
      `readMigrationFiles (dbmate): ${name} — нет строки «-- migrate:up» с начала строки: dbmate такой файл не применяет`,
    );
  }
  const before = sql
    .slice(0, up.index)
    .split('\n')
    .filter((line) => line.trim() !== '' && !/^\s*--/.test(line));
  if (before.length > 0) {
    throw new Error(
      `readMigrationFiles (dbmate): ${name} — операторы до «-- migrate:up»: dbmate такой файл не применяет`,
    );
  }
  const rest = sql.slice(up.index + up[0].length);
  const down = /^--\s*migrate:down\b/m.exec(rest);
  return down === null ? rest : rest.slice(0, down.index);
}
