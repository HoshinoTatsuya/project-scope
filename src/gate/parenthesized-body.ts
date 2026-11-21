/** Содержимое скобок, открытых в начале текста, и остаток после них; несбалансированные — null. */
export function parenthesizedBody(text: string): { readonly body: string; readonly rest: string } | null {
  if (!text.startsWith('(')) {
    return null;
  }
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '(') {
      depth += 1;
    } else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) {
        return { body: text.slice(1, index), rest: text.slice(index + 1).trim() };
      }
    }
  }
  return null;
}
