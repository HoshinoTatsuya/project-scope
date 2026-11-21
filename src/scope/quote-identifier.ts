/** Идентификатор в двойных кавычках (каждая часть `схема.имя` — отдельно). */
export function quoteIdentifier(name: string): string {
  return name
    .split('.')
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join('.');
}
