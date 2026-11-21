/** `public.items` → `items`: таблица схемы public называется без схемы — так их и сравнивают. */
export function normalizeTableName(name: string): string {
  return name.startsWith('public.') ? name.slice('public.'.length) : name;
}
