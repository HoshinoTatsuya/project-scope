import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Входы пакета, которые грузятся вне jest (сервис, CLI, vitest), не тянут
 * `@jest/globals`: его импорт вне раннера jest падает при загрузке модуля.
 * Обвязка гейта для jest — только на своём входе `/gate/jest`.
 *
 * Обход — по относительным импортам исходников от файла входа.
 */
const SRC = __dirname;
const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/g;

const packagesReachedFrom = (entry: string): { files: number; packages: Set<string> } => {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const specifier = match[1] as string;
      if (specifier.startsWith('.')) {
        visit(`${resolve(dirname(file), specifier)}.ts`);
      } else {
        packages.add(specifier);
      }
    }
  };
  visit(join(SRC, entry));
  return { files: seen.size, packages };
};

describe('входы пакета вне jest', () => {
  it.each(['index.ts', 'drizzle.ts', 'gate.ts'])('%s не тянет @jest/globals', (entry) => {
    const reached = packagesReachedFrom(entry);
    expect(reached.files).toBeGreaterThan(1);
    expect([...reached.packages].filter((name) => name === '@jest/globals' || name === 'jest')).toEqual([]);
  });

  it('выборка не выродилась: /gate/jest тянет @jest/globals, /gate — drizzle-orm', () => {
    expect(packagesReachedFrom('gate-jest.ts').packages.has('@jest/globals')).toBe(true);
    expect(packagesReachedFrom('gate.ts').packages.has('drizzle-orm')).toBe(true);
  });
});
