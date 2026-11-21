#!/usr/bin/env bash
# Записывает ответы НАСТОЯЩИХ инструментов миграций на фикстуры раскладок
# (src/testing/layout-oracle/<инструмент>/<случай>/): что применено и в каком
# порядке, или отказ. Каждый файл фикстуры пишет свой путь в oracle_log — так
# видно и состав, и порядок. Результат — src/testing/layout-oracle/answers.json,
# его сверяет спека `read-migration-files.oracle.spec.ts` без docker.
#
# Нужны образы (локально): postgres:17-alpine, migrate/migrate:v4.18.3,
# ghcr.io/amacneil/dbmate:2, flyway/flyway:11. Сеть docker — внутренняя
# (--internal): инструменты не ходят наружу. Перезаписать ответы — после смены
# версии инструмента или новых случаев: scripts/layout-oracle.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="${ROOT}/src/testing/layout-oracle"
OUT="${FIXTURES}/answers.json"
PG_IMAGE="${PG_ORACLE_IMAGE:-postgres:17-alpine}"
GOLANG_MIGRATE_IMAGE="migrate/migrate:v4.18.3"
DBMATE_IMAGE="ghcr.io/amacneil/dbmate:2"
FLYWAY_IMAGE="flyway/flyway:11"
NET="layout-oracle-$$"
PG="layout-oracle-pg-$$"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/layout-oracle-XXXXXX")"
cleanup() {
  docker rm -f -v "${PG}" >/dev/null 2>&1 || true
  docker network rm "${NET}" >/dev/null 2>&1 || true
  case "${WORK}" in
    "${TMPDIR:-/tmp}"/layout-oracle-*) rm -rf "${WORK}" ;;
  esac
}
trap cleanup EXIT

docker network create --internal "${NET}" >/dev/null
docker run -d --rm --name "${PG}" --network "${NET}" -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test "${PG_IMAGE}" >/dev/null
for _ in $(seq 1 120); do
  if docker exec "${PG}" psql -h 127.0.0.1 -U test -d postgres -tAc 'select 1' 2>/dev/null | grep -q 1; then
    break
  fi
  sleep 0.5
done
psql_root() { docker exec -i "${PG}" psql -h 127.0.0.1 -U test -d "$1" -v ON_ERROR_STOP=1 -tA; }

version_of() {
  # Весь вывод читается до конца (awk, а не grep -m1/tail): ранний выход читателя
  # даёт SIGPIPE писателю, и под pipefail скрипт падал на ровном месте.
  local out
  case "$1" in
    golang-migrate) out="$(docker run --rm "${GOLANG_MIGRATE_IMAGE}" -version 2>&1 || true)" ;;
    dbmate) out="$(docker run --rm "${DBMATE_IMAGE}" --version 2>&1 || true)" ;;
    flyway) out="$(docker run --rm -e REDGATE_DISABLE_TELEMETRY=true "${FLYWAY_IMAGE}" -v 2>&1 || true)" ;;
  esac
  awk -v tool="$1" 'NF && (tool != "flyway" || tolower($0) ~ /flyway/) { line = $0 } END { print line }' <<<"${out}"
}

run_tool() {
  local tool="$1" dir="$2" db="$3"
  case "${tool}" in
    golang-migrate)
      docker run --rm --network "${NET}" -v "${dir}:/migrations:ro" "${GOLANG_MIGRATE_IMAGE}" \
        -path=/migrations -database "postgres://test:test@${PG}:5432/${db}?sslmode=disable" up ;;
    dbmate)
      docker run --rm --network "${NET}" -v "${dir}:/migrations:ro" "${DBMATE_IMAGE}" \
        --url "postgres://test:test@${PG}:5432/${db}?sslmode=disable" --migrations-dir /migrations \
        --no-dump-schema up ;;
    flyway)
      docker run --rm --network "${NET}" -e REDGATE_DISABLE_TELEMETRY=true -v "${dir}:/flyway/sql:ro" "${FLYWAY_IMAGE}" \
        "-url=jdbc:postgresql://${PG}:5432/${db}" -user=test -password=test \
        -locations=filesystem:/flyway/sql migrate ;;
  esac
}

LINES="${WORK}/answers.ndjson"
: > "${LINES}"
for tool in golang-migrate dbmate flyway; do
  version="$(version_of "${tool}")"
  for dir in "${FIXTURES}/${tool}"/*/; do
    name="$(basename "${dir}")"
    db="oracle_$(echo "${tool}_${name}" | tr -c 'a-z0-9\n' '_')"
    echo "CREATE DATABASE ${db}" | psql_root postgres >/dev/null
    set +e
    output="$(run_tool "${tool}" "${dir%/}" "${db}" 2>&1)"
    code=$?
    set -e
    applied="$(echo "SELECT coalesce(json_agg(name ORDER BY id), '[]') FROM oracle_log" | psql_root "${db}" 2>/dev/null || echo '[]')"
    node -e '
      const [tool, version, name, code, applied, output] = process.argv.slice(1);
      process.stdout.write(JSON.stringify({ tool, version, case: name, exitCode: Number(code), applied: JSON.parse(applied),
        failure: Number(code) === 0 ? null : output.split("\n").filter((line) => /error|fail|duplicate|found more|unable|requires/i.test(line)).slice(-2).join(" | ") }) + "\n");
    ' "${tool}" "${version}" "${name}" "${code}" "${applied}" "${output}" >> "${LINES}"
  done
done
node -e '
  const lines = require("node:fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map((line) => JSON.parse(line));
  require("node:fs").writeFileSync(process.argv[2], JSON.stringify(lines, null, 2) + "\n");
' "${LINES}" "${OUT}"
# Вывод — через форматтер репозитория: иначе файл в git и вывод генератора расходятся навсегда.
"${ROOT}/node_modules/.bin/biome" format --write "${OUT}" >/dev/null
echo "записано: ${OUT}"
