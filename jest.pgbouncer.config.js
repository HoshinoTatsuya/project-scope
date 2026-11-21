/**
 * Проверки через настоящий PgBouncer в transaction mode (`pnpm test:pgbouncer`:
 * scripts/with-pgbouncer.sh). Один файл, меньше 300 тестов, ≤2 воркера; без
 * адреса пулера набор пропускается — и jest-assert-no-skipped валит прогон.
 */

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.pooler.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  maxWorkers: 2,
  testTimeout: 30_000,
};
