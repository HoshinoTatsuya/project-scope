#!/usr/bin/env bash
# Матрица потребителей: собранный пакет (npm pack) ставится в одноразовые
# проекты с разными настройками модулей. В каждом политики `scopePgPolicies`
# передаются СОБСТВЕННОМУ `pgTable` drizzle потребителя, а `withScope` получает
# его базу и отдаёт работе транзакцию, в которой `tx.select().from(таблица)`
# компилируется (тип транзакции — из базы потребителя, а не класс drizzle из
# деклараций пакета: два файла деклараций одной установки дали бы TS2345 под
# ts-jest при зелёном tsc). Гейт покрытия опознаёт таблицу drizzle потребителя.
#
# Запуск: scripts/consumer-matrix.sh. Каталоги — из mkdtemp, удаляются в конце.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/project-scope-consumers-XXXXXX")"
cleanup() {
  case "${WORK}" in
    "${TMPDIR:-/tmp}"/project-scope-consumers-*) rm -rf "${WORK}" ;;
  esac
}
trap cleanup EXIT

(cd "${ROOT}" && pnpm build >/dev/null && npm pack --silent --pack-destination "${WORK}" >/dev/null)
TARBALL="$(ls "${WORK}"/hoshinotatsuya-project-scope-*.tgz)"

CONSUMER_TS="import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { pgTable, serial, uuid } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';
import {
  assertScopeReady, defineProjectScope, SCOPE_COLUMN_TYPE, SCOPE_PROBLEM, ScopeNotReadyError, scopePolicySql,
  withCrossScope, withScope,
} from '@hoshinotatsuya/project-scope';
import { scopePgPolicies } from '@hoshinotatsuya/project-scope/drizzle';
import { evaluateScopeCoverage } from '@hoshinotatsuya/project-scope/gate';
import type { scopeCoverageGate } from '@hoshinotatsuya/project-scope/gate/jest';

// skipLibCheck прячет ошибки в декларациях пакета, а нерезолвящийся импорт в них
// молча становится any. Утверждение ниже не компилируется, если экспорт стал any.
type IsAny<T> = 0 extends 1 & T ? true : false;
type NotAny<T> = IsAny<T> extends true ? never : true;
export const typed: [
  NotAny<typeof withScope>, NotAny<typeof withCrossScope>, NotAny<typeof assertScopeReady>,
  NotAny<typeof scopePgPolicies>, NotAny<typeof evaluateScopeCoverage>, NotAny<typeof ScopeNotReadyError>,
  NotAny<ReturnType<typeof scopePgPolicies>[number]>, NotAny<typeof scopeCoverageGate>,
] = [true, true, true, true, true, true, true, true];

export const scope = defineProjectScope({
  setting: 'app.project_id', column: 'project_id', columnType: SCOPE_COLUMN_TYPE.uuid, tables: ['items'],
  maintenanceRole: 'app_maintenance',
});
export const items = pgTable('items', { id: serial('id').primaryKey(), projectId: uuid('project_id').notNull() }, () =>
  scopePgPolicies(scope),
).enableRLS();
export const migration: string = scopePolicySql(scope);
export const problem: string = SCOPE_PROBLEM.superuser;
export const listItems = (db: NodePgDatabase & { \$client: Pool }, projectId: string) =>
  withScope(db, scope, projectId, (tx) => tx.select().from(items));
export const cleanup = (db: NodePgDatabase & { \$client: Pool }) =>
  withCrossScope(db, scope, { reason: 'очистка всех проектов' }, (tx) => tx.delete(items));
export const coverage = () => evaluateScopeCoverage({ scope, schema: { items }, migrations: [] });
"

SPEC_TS="import { scopeCoverageGate } from '@hoshinotatsuya/project-scope/gate/jest';
import { coverage } from './consumer';

it('таблица drizzle потребителя опознаётся гейтом пакета', () => {
  expect(coverage().scopedInSchema).toEqual(['items']);
});

it('обвязка гейта для jest грузится в jest потребителя', () => {
  expect(typeof scopeCoverageGate).toBe('function');
});
"

failures=0
run_case() {
  local label="$1" module="$2" resolution="$3" type="$4" jest="$5" runtime="${6:-0.9.1}"
  local dir="${WORK}/${label}"
  mkdir -p "${dir}/src"
  cat >"${dir}/package.json" <<JSON
{
  "name": "consumer-${label}",
  "private": true,
  "type": "${type}",
  "dependencies": {
    "@hoshinotatsuya/project-scope": "file:${TARBALL}",
    "@hoshinotatsuya/pg-runtime": "${runtime}",
    "drizzle-orm": "0.45.2",
    "pg": "8.21.0"
  },
  "devDependencies": {
    "@jest/globals": "30.4.1",
    "@types/jest": "30.0.0",
    "@types/node": "24.0.15",
    "@types/pg": "8.23.1",
    "jest": "30.4.2",
    "ts-jest": "29.4.11",
    "typescript": "6.0.3"
  }
}
JSON
  local resolution_line=""
  if [[ -n "${resolution}" ]]; then
    resolution_line="\"moduleResolution\": \"${resolution}\","
  fi
  cat >"${dir}/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "module": "${module}",
    ${resolution_line}
    "target": "ES2024",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["jest", "node"],
    "noEmit": true
  },
  "include": ["src"]
}
JSON
  printf '%s' "${CONSUMER_TS}" >"${dir}/src/consumer.ts"
  # ESM с nodenext требует расширение в относительном импорте; CJS-раннер jest — без него.
  if [[ "${type}" == "module" && "${resolution}" == "nodenext" ]]; then
    printf '%s' "${SPEC_TS}" | sed "s#'./consumer'#'./consumer.js'#" >"${dir}/src/consumer.spec.ts"
  else
    printf '%s' "${SPEC_TS}" >"${dir}/src/consumer.spec.ts"
  fi
  cat >"${dir}/jest.config.js" <<'JS'
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  maxWorkers: 2,
};
JS
  (cd "${dir}" && pnpm install --prefer-offline --silent >"${dir}/install.log" 2>&1) || {
    echo "${label}: установка не прошла"; tail -5 "${dir}/install.log"; failures=$((failures + 1)); return
  }
  if (cd "${dir}" && node_modules/.bin/tsc -p tsconfig.json >"${dir}/tsc.log" 2>&1); then
    echo "${label}: tsc — зелёный"
  else
    echo "${label}: tsc — КРАСНЫЙ"; head -5 "${dir}/tsc.log"; failures=$((failures + 1))
  fi
  # Рантайм того же условия, которое выбирают декларации: import для ESM-проекта, require — для CJS.
  # Вход ./gate грузится и вне jest (сервис, CLI, vitest); обвязка для jest — ./gate/jest, её рантайм
  # проверяет спека потребителя.
  local runtime='const o = require("@hoshinotatsuya/project-scope"); const d = require("@hoshinotatsuya/project-scope/drizzle"); const g = require("@hoshinotatsuya/project-scope/gate"); if (typeof o.withScope !== "function" || typeof d.scopePgPolicies !== "function" || typeof g.evaluateScopeCoverage !== "function") process.exit(1);'
  if [[ "${type}" == "module" ]]; then
    runtime='const o = await import("@hoshinotatsuya/project-scope"); const d = await import("@hoshinotatsuya/project-scope/drizzle"); const g = await import("@hoshinotatsuya/project-scope/gate"); if (typeof o.withScope !== "function" || typeof d.scopePgPolicies !== "function" || typeof g.evaluateScopeCoverage !== "function") process.exit(1);'
  fi
  if (cd "${dir}" && node --input-type="$([[ "${type}" == "module" ]] && echo module || echo commonjs)" -e "${runtime}" >"${dir}/runtime.log" 2>&1); then
    echo "${label}: рантайм входов — зелёный"
  else
    echo "${label}: рантайм входов — КРАСНЫЙ"; head -5 "${dir}/runtime.log"; failures=$((failures + 1))
  fi
  if [[ "${jest}" == "jest" ]]; then
    if (cd "${dir}" && node_modules/.bin/jest --maxWorkers=2 >"${dir}/jest.log" 2>&1); then
      echo "${label}: ts-jest — зелёный ($(grep -E '^Tests:' "${dir}/jest.log"))"
    else
      echo "${label}: ts-jest — КРАСНЫЙ"; grep -E 'TS[0-9]+|Tests:' "${dir}/jest.log" | head -5; failures=$((failures + 1))
    fi
  fi
}

run_case commonjs commonjs "" commonjs jest
run_case node16 node16 node16 commonjs jest
run_case nodenext nodenext nodenext commonjs jest
run_case bundler-esm esnext bundler module tsc-only
run_case nodenext-esm nodenext nodenext module tsc-only
# Прежние линии pg-runtime (0.7, 0.8) на npmjs.com не публиковались: их совместимость проверена
# до публикации и в публичном CI не повторяется — ставить нечего.

if [[ "${failures}" -gt 0 ]]; then
  echo "матрица потребителей: красных ${failures}"
  exit 1
fi
echo "матрица потребителей: все зелёные"
