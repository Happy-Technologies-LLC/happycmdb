#!/usr/bin/env bash
# HAP-1754: the api image must still start after the build-hygiene changes in infrastructure/docker/Dockerfile.api
# (npm ci, host dist removed before tsc, devDependencies and test files pruned out of the production stage).
# Run by the `api-image-nmap` job in .github/workflows/test.yml, and by operators where Docker exists.
# Usage: deploy/test-api-image-start.sh <api-image>
# The container has no network: no database is reachable, so the process cannot become healthy. What it proves is
# that every module in the pruned tree resolves and the server reaches its start-up log line. A module the prune
# removed but the runtime needs fails as "Cannot find module" before that line.
set -euo pipefail

image=${1:?usage: $0 <api-image>}
marker="Starting HappyCMDB API Server"

# Placeholders only: nothing here is a credential and nothing listens on these ports.
cid=$(docker run -d --network none \
  -e NODE_ENV=production -e PORT=3000 \
  -e NEO4J_URI=bolt://127.0.0.1:1 -e NEO4J_USERNAME=neo4j -e NEO4J_USER=neo4j -e NEO4J_PASSWORD=placeholder-not-a-secret \
  -e POSTGRES_HOST=127.0.0.1 -e POSTGRES_PORT=1 -e POSTGRES_DATABASE=cmdb -e POSTGRES_DB=cmdb -e POSTGRES_USER=placeholder -e POSTGRES_PASSWORD=placeholder-not-a-secret \
  -e REDIS_HOST=127.0.0.1 -e REDIS_PORT=1 \
  -e KAFKA_BROKERS=127.0.0.1:1 -e KAFKA_CLIENT_ID=image-start-test -e KAFKA_GROUP_ID=image-start-test \
  -e JWT_SECRET=placeholder-not-a-secret-placeholder-not-a-secret \
  -e CREDENTIAL_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  -e AUDIT_CHAIN_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  "$image")
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT

# Capture logs into a variable: with pipefail, `docker logs | grep -q` / `| head` can fail on SIGPIPE.
started=no
logs=
for _ in $(seq 1 60); do
  logs=$(docker logs "$cid" 2>&1 || true)
  if grep -q "$marker" <<<"$logs"; then started=yes; break; fi
  [ "$(docker inspect -f '{{.State.Running}}' "$cid")" = true ] || break
  sleep 1
done
printf '%s\n' "$logs" | cut -c1-240 | head -40 || true
[ "$started" = yes ] || { echo "FAIL: '$marker' never logged" >&2; exit 1; }
if grep -q "Cannot find module" <<<"$logs"; then
  echo "FAIL: a module is missing from the production image" >&2; exit 1
fi

echo "pruned tree: no devDependencies, no test dirs; migrations and connector.json files kept"
docker run --rm --entrypoint sh "$image" -c '
  set -eu
  [ ! -e node_modules/typescript ] && [ ! -e node_modules/jest ]
  [ -z "$(find packages -name node_modules -prune -o \( -name __tests__ -o -name __mocks__ \) -print)" ]
  [ -z "$(find packages -name node_modules -prune -o -name "*.test.*" -print)" ]
  [ -f packages/database/src/postgres/migrations/001_complete_schema.sql ]
  [ -f packages/connectors/aws/connector.json ]
  [ -f packages/database/dist/postgres/run-migrations.js ]'
echo OK
