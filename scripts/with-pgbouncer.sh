#!/usr/bin/env bash
# Postgres и PgBouncer в transaction mode перед ним (docker): адрес суперпользователя
# Postgres напрямую — в PG_TEST_URL, через пулер — в PG_POOLER_URL, затем переданная
# команда. Стенд проверки: пулер проверяет пароли ролей запросом к pg_shadow (auth_query
# под суперпользователем стенда), сервер доверяет соединениям сети стенда (trust); у
# пулера одно серверное соединение на базу и роль — соседи делят его по очереди.
set -euo pipefail
IMAGE="${PG_TEST_IMAGE:-postgres:17-alpine}"
POOLER_IMAGE="${PG_POOLER_IMAGE:-edoburu/pgbouncer:latest}"
TAG="project-scope-pooler-$$"
NET="${TAG}-net"
PG="${TAG}-pg"
POOLER="${TAG}-pgbouncer"
CONFIG="$(mktemp -d "${TMPDIR:-/tmp}/project-scope-pgbouncer-XXXXXX")"
# mktemp -d creates 0700: the pooler user in the container could not read the mounted
# config (seen as a missing userlist.txt) on Linux, where bind mounts keep host permissions.
chmod 755 "${CONFIG}"
cleanup() {
  docker rm -f -v "${PG}" "${POOLER}" >/dev/null 2>&1 || true
  docker network rm "${NET}" >/dev/null 2>&1 || true
  case "${CONFIG}" in
    "${TMPDIR:-/tmp}"/project-scope-pgbouncer-*) rm -rf "${CONFIG}" ;;
  esac
}
trap cleanup EXIT
docker network create "${NET}" >/dev/null
docker run -d --name "${PG}" --network "${NET}" -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:0:5432 "${IMAGE}" -c fsync=off >/dev/null
for _ in $(seq 1 120); do
  if docker exec "${PG}" psql -h 127.0.0.1 -U test -d postgres -tAc 'select 1' 2>/dev/null | grep -q 1; then
    break
  fi
  sleep 0.5
done
docker exec "${PG}" psql -h 127.0.0.1 -U test -d postgres -tAc 'select 1' | grep -q 1 || { echo "postgres не поднялся" >&2; exit 1; }
cat >"${CONFIG}/pgbouncer.ini" <<INI
[databases]
* = host=${PG} port=5432

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 5432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
auth_user = test
auth_query = SELECT usename, passwd FROM pg_shadow WHERE usename = \$1
pool_mode = transaction
default_pool_size = 1
max_client_conn = 200
ignore_startup_parameters = extra_float_digits
admin_users = test
INI
echo '"test" "test"' >"${CONFIG}/userlist.txt"
chmod 644 "${CONFIG}/pgbouncer.ini" "${CONFIG}/userlist.txt"
docker run -d --name "${POOLER}" --network "${NET}" -v "${CONFIG}:/etc/pgbouncer:ro" \
  -p 127.0.0.1:0:5432 "${POOLER_IMAGE}" >/dev/null
port_of() { docker port "$1" 5432/tcp | head -1 | sed 's/.*://'; }
export PG_TEST_URL="postgres://test:test@127.0.0.1:$(port_of "${PG}")/postgres"
export PG_POOLER_URL="postgres://test:test@127.0.0.1:$(port_of "${POOLER}")/postgres"
for _ in $(seq 1 60); do
  if node -e "const {Client}=require('pg');const c=new Client({connectionString:process.env.PG_POOLER_URL});c.connect().then(()=>c.query('select 1')).then(()=>c.end()).then(()=>process.exit(0),()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
"$@"
