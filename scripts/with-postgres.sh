#!/usr/bin/env bash
# Поднимает одноразовый Postgres в docker на свободном порту, отдаёт адрес
# суперпользователя в PG_TEST_URL и запускает переданную команду. Адрес уже
# задан (CI-сервис) — docker не нужен. Контейнер удаляется вместе с томами
# (`rm -f -v`: без -v анонимный том остаётся на диске после каждого прогона).
set -euo pipefail
if [[ -n "${PG_TEST_URL:-}" ]]; then
  exec "$@"
fi
IMAGE="${PG_TEST_IMAGE:-postgres:17-alpine}"
NAME="project-scope-test-$$"
docker run -d --rm --name "${NAME}" -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test \
  -p 127.0.0.1:0:5432 "${IMAGE}" >/dev/null
trap 'docker rm -f -v "${NAME}" >/dev/null 2>&1 || true' EXIT
PORT="$(docker port "${NAME}" 5432/tcp | head -1 | sed 's/.*://')"
# Готовность — настоящим запросом ПО TCP. Временный сервер initdb слушает
# только unix-сокет и отвечает на select 1, а затем перезапускается: проверка
# через сокет проскакивала на него, и первый запрос теста попадал в рестарт.
for _ in $(seq 1 120); do
  if docker exec "${NAME}" psql -h 127.0.0.1 -U test -d postgres -tAc 'select 1' 2>/dev/null | grep -q 1; then
    break
  fi
  sleep 0.5
done
docker exec "${NAME}" psql -h 127.0.0.1 -U test -d postgres -tAc 'select 1' | grep -q 1 || { echo "postgres не поднялся" >&2; exit 1; }
PG_TEST_URL="postgres://test:test@127.0.0.1:${PORT}/postgres" "$@"
