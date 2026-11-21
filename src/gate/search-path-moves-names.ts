/**
 * Уводит ли значение `search_path` имена без схемы из public: гейт читает
 * `items` как `public.items`, а сервер создаёт и ищет имя в ПЕРВОЙ схеме пути.
 * Безопасно: `public` первым, `"$user", public` (путь по умолчанию — роль без
 * своей схемы), `DEFAULT`. Значение, которое не разобрать, — уводит
 * (не определить = отказ).
 */
export function searchPathMovesNames(value: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }
  const entries = value
    .split(',')
    .map((entry) =>
      entry
        .trim()
        .replace(/^'((?:[^']|'')*)'$/, '$1')
        .replace(/^"((?:[^"]|"")*)"$/, '$1')
        .trim(),
    )
    .filter((entry) => entry !== '');
  const [first, second] = entries.map((entry) => (entry === '$user' ? entry : entry.toLowerCase()));
  if (first === 'default' && entries.length === 1) {
    return false;
  }
  return !(first === 'public' || (first === '$user' && second === 'public'));
}
