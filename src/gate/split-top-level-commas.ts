/** Части текста по запятым вне скобок (элементы CREATE TABLE, действия ALTER TABLE). */
export function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    }
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim() !== '') {
    parts.push(current.trim());
  }
  return parts;
}
