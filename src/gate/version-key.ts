/**
 * Версия миграции в той записи, которой её сравнивает инструмент: числа без
 * ведущих нулей, без нулей в конце (Flyway: `1`, `1.0`, `01` — одна версия,
 * и он отказывает на втором файле; `1_1` = `1.1`).
 */
export function versionKey(version: string): string {
  const parts = version.split(/[._]/).map((part) => BigInt(part));
  while (parts.length > 1 && parts[parts.length - 1] === 0n) {
    parts.pop();
  }
  return parts.join('.');
}
