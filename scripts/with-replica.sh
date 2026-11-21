#!/usr/bin/env bash
# Основной сервер и горячая реплика (потоковая репликация) в docker: адрес
# суперпользователя основного — в PG_TEST_URL, реплики — в PG_REPLICA_URL, затем
# переданная команда. Контейнеры, сеть и тома удаляются в конце.
set -euo pipefail
IMAGE="${PG_TEST_IMAGE:-postgres:17-alpine}"
TAG="project-scope-replica-$$"
NET="${TAG}-net"
PRIMARY="${TAG}-primary"
REPLICA="${TAG}-replica"
cleanup() {
  docker rm -f -v "${PRIMARY}" "${REPLICA}" >/dev/null 2>&1 || true
  docker network rm "${NET}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
wait_recovery() {
  local name="$1" expect="$2"
  for _ in $(seq 1 240); do
    if [[ "$(docker exec "${name}" psql -h 127.0.0.1 -U test -d postgres -tAc 'select pg_is_in_recovery()' 2>/dev/null || true)" == "${expect}" ]]; then
      return 0
    fi
    sleep 0.5
  done
  echo "${name} не поднялся" >&2
  docker logs "${name}" 2>&1 | tail -20 >&2
  return 1
}
docker network create "${NET}" >/dev/null
docker run -d --name "${PRIMARY}" --network "${NET}" -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test \
  -p 127.0.0.1:0:5432 "${IMAGE}" -c fsync=off -c wal_level=replica >/dev/null
wait_recovery "${PRIMARY}" f
docker exec "${PRIMARY}" sh -c 'echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"'
docker exec "${PRIMARY}" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -U test -d postgres -qc \
  "CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicator'; SELECT pg_reload_conf();" >/dev/null
docker run -d --name "${REPLICA}" --network "${NET}" --user postgres -e PGPASSWORD=replicator \
  -p 127.0.0.1:0:5432 --entrypoint sh "${IMAGE}" -c \
  "set -e; if [ ! -s \"\$PGDATA/PG_VERSION\" ]; then pg_basebackup -h ${PRIMARY} -U replicator -D \"\$PGDATA\" -R -X stream -c fast; chmod 700 \"\$PGDATA\"; fi; exec postgres" >/dev/null
wait_recovery "${REPLICA}" t
port_of() { docker port "$1" 5432/tcp | head -1 | sed 's/.*://'; }
export PG_TEST_URL="postgres://test:test@127.0.0.1:$(port_of "${PRIMARY}")/postgres"
export PG_REPLICA_URL="postgres://test:test@127.0.0.1:$(port_of "${REPLICA}")/postgres"
"$@"
