/** Схема и имя таблицы области (`items` → public). */
export function splitTableName(name: string): { readonly schema: string; readonly name: string } {
  const dot = name.indexOf('.');
  return dot === -1 ? { schema: 'public', name } : { schema: name.slice(0, dot), name: name.slice(dot + 1) };
}
