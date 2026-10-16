#!/usr/bin/env bash
# Founder-only, disposable Build01 N-18 proof. NEVER run against existing services.
# Image digests: Docker Hub linux/amd64 image detail pages (not mutable tags):
# https://hub.docker.com/layers/library/neo4j/5.15.0/images/sha256-69c579facb7acab1e98f28952b91144c89e469a081804a5dafebd6c3030433b8
# https://hub.docker.com/layers/timescale/timescaledb/2.28.3-pg15/images/sha256-ab92d61763e450dbb814072b48fdcd8b7258a9432e520941848472e0cd3bcc0e
# https://hub.docker.com/layers/library/redis/7-alpine3.21/images/sha256-ca0acbb137c1dc3339c8b147a58fd6f42775d4599327b50e7b116c23de501af2
set -euo pipefail
umask 077

[[ $# -eq 1 && $1 =~ ^[a-f0-9]{40}$ ]] || { echo 'Usage: run-n18-receipt.sh <exact-40-character-PR-head-SHA>' >&2; exit 2; }
expected_head=$1
repo=$(git rev-parse --show-toplevel)
cd "$repo"
[[ $(git rev-parse HEAD) == "$expected_head" ]] || { echo 'Refusing checkout other than the specified exact PR head' >&2; exit 2; }
[[ -z $(git status --porcelain --untracked-files=normal) ]] || { echo 'Refusing non-clean source checkout' >&2; exit 2; }
[[ -x node_modules/.bin/jest ]] || { echo 'Install locked npm dependencies in this checkout before running the script' >&2; exit 2; }
for binary in docker node timeout; do command -v "$binary" >/dev/null || { echo "Missing required command: $binary" >&2; exit 2; }; done
for key in POSTGRES_HOST POSTGRES_PORT POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DATABASE_URL PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD NEO4J_URI NEO4J_USERNAME NEO4J_PASSWORD NEO4J_AUTH REDIS_HOST REDIS_PORT REDIS_PASSWORD REDIS_URL AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE AWS_WEB_IDENTITY_TOKEN_FILE AWS_SHARED_CREDENTIALS_FILE AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TENANT_ID AZURE_CLIENT_CERTIFICATE_PATH GCP_SERVICE_ACCOUNT_KEY GCP_SERVICE_ACCOUNT_KEY_PATH GOOGLE_APPLICATION_CREDENTIALS; do
  [[ ! -v $key ]] || { echo "Refusing a preconfigured store or provider credential variable: $key" >&2; exit 2; }
done

neo_image='neo4j@sha256:69c579facb7acab1e98f28952b91144c89e469a081804a5dafebd6c3030433b8'
pg_image='timescale/timescaledb@sha256:ab92d61763e450dbb814072b48fdcd8b7258a9432e520941848472e0cd3bcc0e'
redis_image='redis@sha256:ca0acbb137c1dc3339c8b147a58fd6f42775d4599327b50e7b116c23de501af2'
nonce="${expected_head:0:12}-$$"
neo_name="n18-neo-$nonce"
pg_name="n18-pg-$nonce"
redis_name="n18-redis-$nonce"
session_label="${AO_SESSION_ID:-founder-n18-$nonce}"
run_label="n18.run=$nonce"
receipt_dir="$repo/test-results/n18"
[[ ! -L "$repo/test-results" && ! -L "$receipt_dir" ]] || { echo 'Refusing symlinked receipt directory' >&2; exit 2; }
mkdir -p "$receipt_dir"
chmod 700 "$receipt_dir"
receipt="$receipt_dir/$nonce.jsonl"
run_log="$receipt_dir/$nonce.run.log"
schema_log="$receipt_dir/$nonce.migrations.log"
: > "$receipt"
: > "$run_log"
: > "$schema_log"
started=("$pg_name" "$neo_name" "$redis_name")
cleanup() {
  local status=$? teardown=0 name ids id
  trap - EXIT INT TERM
  for name in "${started[@]}"; do
    if ! ids=$(docker container ls -aq --filter "name=^/${name}$" --filter "label=ao.session=$session_label" --filter "label=$run_label"); then
      teardown=1
      continue
    fi
    while IFS= read -r id; do
      [[ -z $id ]] || docker rm -f "$id" >/dev/null 2>&1 || teardown=1
    done <<< "$ids"
  done
  if [[ $status -eq 0 && $teardown -ne 0 ]]; then status=1; fi
  printf 'N18_TEARDOWN=%s N18_EXIT_STATUS=%s HEAD=%s RECEIPT=%s\n' "$([[ $teardown -eq 0 ]] && echo ok || echo failed)" "$status" "$expected_head" "$receipt" | tee -a "$run_log"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'N18_HEAD=%s IMAGES=%s,%s,%s\n' "$expected_head" "$neo_image" "$pg_image" "$redis_image" | tee -a "$run_log"
for image in "$neo_image" "$pg_image" "$redis_image"; do docker pull --platform linux/amd64 "$image" >/dev/null; done

# No host mounts, no external/production data, no provider tokens. Every published socket binds loopback only.
docker run -d --rm --platform linux/amd64 --pull never --name "$pg_name" --label "ao.session=$session_label" --label "$run_label" -p 127.0.0.1::5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=testpassword -e POSTGRES_DB=cmdb_test "$pg_image" >/dev/null
docker run -d --rm --platform linux/amd64 --pull never --name "$neo_name" --label "ao.session=$session_label" --label "$run_label" -p 127.0.0.1::7687 -e NEO4J_AUTH=neo4j/testpassword "$neo_image" >/dev/null
docker run -d --rm --platform linux/amd64 --pull never --name "$redis_name" --label "ao.session=$session_label" --label "$run_label" -p 127.0.0.1::6379 "$redis_image" >/dev/null
for attempt in {1..120}; do docker exec "$pg_name" pg_isready -U test -d cmdb_test >/dev/null 2>&1 && break; sleep 1; done
docker exec "$pg_name" pg_isready -U test -d cmdb_test >/dev/null
for attempt in {1..120}; do docker exec "$neo_name" cypher-shell -u neo4j -p testpassword 'RETURN 1' >/dev/null 2>&1 && break; sleep 1; done
docker exec "$neo_name" cypher-shell -u neo4j -p testpassword 'RETURN 1' >/dev/null
for attempt in {1..60}; do [[ $(docker exec "$redis_name" redis-cli ping 2>/dev/null) == PONG ]] && break; sleep 1; done
docker exec "$redis_name" redis-cli ping >/dev/null

port() {
  local binding
  binding=$(docker port "$1" "$2/tcp")
  [[ $binding =~ ^127\.0\.0\.1:[0-9]+$ ]] || { echo "Refusing non-loopback binding for $1:$2" >&2; return 1; }
  printf '%s' "${binding##*:}"
}
pg_port=$(port "$pg_name" 5432)
neo_port=$(port "$neo_name" 7687)
redis_port=$(port "$redis_name" 6379)

# Match tests/setup/postgres-schema.ts: ordered canonical migrations; 028-035 are guarded and atomic.
for file in packages/database/src/postgres/migrations/*.sql; do
  if [[ ${file##*/} =~ ^0(28|29|30|31|32|33|34|35)_ ]]; then
    docker exec -i "$pg_name" psql -v ON_ERROR_STOP=1 -1 -U test -d cmdb_test < "$file" >> "$schema_log" 2>&1
  else
    docker exec -i "$pg_name" psql -v ON_ERROR_STOP=0 -U test -d cmdb_test < "$file" >> "$schema_log" 2>&1
  fi
done
[[ $(docker exec "$pg_name" psql -U test -d cmdb_test -tAc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('api_keys','oauth_states','ci_reconciliation_operations','ci_reconciliation_epochs')") == 4 ]] || { echo 'Canonical PostgreSQL schema incomplete' >&2; exit 1; }
docker exec -i "$neo_name" cypher-shell -u neo4j -p testpassword >/dev/null <<'CYPHER'
CREATE CONSTRAINT ci_id_unique IF NOT EXISTS FOR (ci:CI) REQUIRE ci.id IS UNIQUE;
CREATE INDEX ci_type_idx IF NOT EXISTS FOR (ci:CI) ON (ci.type);
CREATE INDEX ci_status_idx IF NOT EXISTS FOR (ci:CI) ON (ci.status);
CREATE INDEX ci_environment_idx IF NOT EXISTS FOR (ci:CI) ON (ci.environment);
CREATE INDEX ci_name_idx IF NOT EXISTS FOR (ci:CI) ON (ci.name);
CREATE FULLTEXT INDEX ci_fulltext_idx IF NOT EXISTS FOR (ci:CI) ON EACH [ci.name, ci.type, ci.external_id];
CYPHER

export NODE_ENV=test LOG_LEVEL=warn POSTGRES_HOST=127.0.0.1 POSTGRES_PORT="$pg_port" POSTGRES_DB=cmdb_test POSTGRES_USER=test POSTGRES_PASSWORD=testpassword
export NEO4J_URI="bolt://127.0.0.1:$neo_port" NEO4J_USERNAME=neo4j NEO4J_PASSWORD=testpassword REDIS_HOST=127.0.0.1 REDIS_PORT="$redis_port"
export JWT_SECRET=test-jwt-secret-for-integration-tests CREDENTIAL_ENCRYPTION_KEY=test-encryption-key-minimum-32-chars-required-for-security
export KAFKA_CLIENT_ID=cmdb-test KAFKA_GROUP_ID=cmdb-test-group N18_RECEIPT_PATH="$receipt" N18_RUN_NONCE="$nonce"
set +e
NODE_OPTIONS=--experimental-vm-modules timeout --signal=TERM --kill-after=30s 1500s ./node_modules/.bin/jest --config packages/etl-processor/tests/scratch/jest.n18.config.cjs --runInBand --runTestsByPath packages/etl-processor/tests/scratch/hp1-s3-queue-persistence.test.ts 2>&1 | tee -a "$run_log"
test_status=${PIPESTATUS[0]}
set -e
[[ $test_status -eq 0 ]] || { echo "N18_JEST_EXIT_STATUS=$test_status" | tee -a "$run_log"; exit "$test_status"; }

# Never treat a partial receipt as complete, even if Jest returned success.
node - "$receipt" <<'JS' | tee -a "$run_log"
const fs = require('fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(JSON.parse);
const queues = ['discovery-aws','discovery-azure','discovery-gcp','discovery-ssh','discovery-nmap',
  'discovery-active-directory','discovery-snmp','discovery-ai','etl-sync','etl-reconciliation',
  'etl-change-detection','etl-full-refresh','etl-cis','etl-costs','etl-incidents',
  'cost-sync-aws','cost-sync-azure','cost-sync-gcp','cost-sync'];
const orgs = ['aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'];
if (rows.length !== 57 || queues.length !== 19) throw new Error(`Incomplete N18 receipt: ${rows.length}/57 cases`);
for (const queue of queues) {
  const cases = rows.filter(row => row.queue === queue);
  if (cases.length !== 3 || !orgs.every(org => cases.some(row => row.organizationId === org && row.phase === 'normal')) ||
    !cases.some(row => row.organizationId === orgs[1] && row.phase === 'forced-failure')) {
    throw new Error(`Incomplete N18 queue matrix: ${queue}`);
  }
}
if (rows.some(row => !row.markerAbsent || !['completed','failed'].includes(row.state))) throw new Error('Unsafe N18 receipt');
console.log('| queue | org | phase | persisted result | logs | failedReason | stack | data (legacy/DLQ) | marker absent |');
console.log('|---|---|---|---|---|---|---:|---|---|');
for (const row of rows) console.log(`| ${row.queue} | ${row.organizationId === orgs[0] ? 'A' : 'B'} | ${row.phase} | ${JSON.stringify(row.returnvalue)} | ${JSON.stringify(row.logs)} | ${row.failedReason || 'none'} | ${row.stacktrace.length} | ${JSON.stringify(row.data)} | ${row.markerAbsent} |`);
JS
printf 'N18_RESULT=57/57 HEAD=%s RECEIPT=%s\n' "$expected_head" "$receipt" | tee -a "$run_log"
