/**
 * Полный набор запускается ТОЛЬКО через `pnpm test` (jest-groups: группы
 * ≤300 тестов, ≤2 воркера, последовательно). Прямой `jest` — для одного-двух
 * файлов и тоже с --maxWorkers=2.
 */

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  // Наборы стендов — своими конфигурациями: реплика (`pnpm test:replica`) и PgBouncer (`pnpm test:pgbouncer`).
  testPathIgnorePatterns: ['/node_modules/', '\\.replica\\.spec\\.ts$', '\\.pooler\\.spec\\.ts$'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  maxWorkers: 2,
  // Потолок каждого теста и хука явно: спека с ожиданием блокировки или
  // зависшим соединением падает тестом, а не держит общую очередь прогонов.
  testTimeout: 15_000,
  clearMocks: true,
  restoreMocks: true,
};
