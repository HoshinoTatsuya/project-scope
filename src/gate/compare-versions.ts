import { versionKey } from './version-key';

/**
 * Версии миграций по числам: `2` < `10`, `1.9` < `1.10`, `1_1` = `1.1`,
 * `1.0` = `1` (Flyway допускает и точку, и подчёркивание; нули в конце не
 * значат ничего). Равные числами — по тексту, чтобы порядок не зависел от
 * порядка чтения каталога (равные версии гейт отвергает раньше).
 */
export function compareVersions(left: string, right: string): number {
  const a = versionKey(left).split('.').map(BigInt);
  const b = versionKey(right).split('.').map(BigInt);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? -1n;
    const y = b[index] ?? -1n;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return left < right ? -1 : left > right ? 1 : 0;
}
