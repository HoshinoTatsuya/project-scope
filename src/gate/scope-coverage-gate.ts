import { describe, expect, it } from '@jest/globals';

import type { ScopeCoverageOptions } from '../types/scope-coverage-options.type';
import { evaluateScopeCoverage } from './evaluate-scope-coverage';

/**
 * Гейт для jest: в спеке проекта — один вызов на область. Проверки:
 * выборка не выродилась (таблицы схемы, миграции, таблицы области — не меньше
 * порогов) И нарушений ноль. Первое без второго — «проверено» про пустое
 * множество, второе без первого — то же самое.
 */
export function scopeCoverageGate(options: ScopeCoverageOptions): void {
  describe(`покрытие области ${options.scope.setting}`, () => {
    const report = evaluateScopeCoverage(options);

    it('выборка не выродилась: схема, миграции и таблицы области найдены', () => {
      expect(report.schemaTables).toBeGreaterThanOrEqual(options.minSchemaTables ?? 1);
      expect(report.migrations).toBeGreaterThanOrEqual(options.minMigrations ?? 1);
      expect(report.scopedInSchema.length).toBeGreaterThan(0);
      expect(report.scopedInMigrations.length).toBeGreaterThan(0);
    });

    it('каждая таблица с колонкой области — в списке и под RLS с той миграции, что её создала', () => {
      expect(report.violations).toEqual([]);
    });
  });
}
