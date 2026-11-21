/** Тело `U&"…"` без UESCAPE: `\XXXX`, `\+XXXXXX` и `\\` — так, как их раскрывает сервер. */
export function unicodeIdentifier(body: string): string {
  return body.replace(
    /\\(?:\\|\+([0-9A-Fa-f]{6})|([0-9A-Fa-f]{4}))/g,
    (whole, long?: string, short?: string) =>
      whole === '\\\\' ? '\\' : String.fromCodePoint(Number.parseInt(long ?? short ?? '', 16)),
  );
}
