/**
 * Проверки на горячей реплике (`pnpm test:replica`: scripts/with-replica.sh
 * поднимает основной сервер и потоковую реплику). Один файл, меньше 300
 * тестов, ≤2 воркера; без адреса реплики набор пропускается — и
 * jest-assert-no-skipped валит прогон.
 */

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.replica.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  maxWorkers: 2,
  testTimeout: 30_000,
};
