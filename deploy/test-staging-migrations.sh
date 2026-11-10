#!/usr/bin/env bash
# Disposable CI-only proof; never point this at a staging Compose project or volume.
set -euo pipefail

cd "$(dirname "$0")/.."
export POSTGRES_PASSWORD=ci_disposable_password
export POSTGRES_APP_PASSWORD=ci_disposable_app_login_password_0123456789
export NEO4J_PASSWORD=ci_disposable_password
export JWT_SECRET=ci_disposable_jwt_secret_0123456789abcdef
export JWT_ISSUER=ci_disposable_issuer
export JWT_AUDIENCE=ci_disposable_audience
export ENCRYPTION_KEY=ci_disposable_encryption_key_0123456789
export AUDIT_CHAIN_KEY=ci_disposable_audit_chain_key
export STAGING_PUBLIC_URL=https://ci.invalid
export COMPOSE_PROJECT_NAME="stg-mig-ci-${GITHUB_RUN_ID:?CI only}-${GITHUB_RUN_ATTEMPT:?CI only}"
# Unconditional: an inherited IMAGE_TAG must never let the build retag an image the real staging deploy uses.
export IMAGE_TAG="$COMPOSE_PROJECT_NAME"

compose() { docker compose -f deploy/build01-staging.compose.yml "$@"; }
services=$(compose config --services)
for one_shot in app-login migrator; do
  if printf '%s\n' "$services" | grep -qx "$one_shot"; then
    echo "Default compose services unexpectedly include $one_shot" >&2
    exit 1
  fi
  compose --profile migrate config --services | grep -qx "$one_shot"
done

# Inspect the actual unqualified up plan without creating any services.
up_plan=$(compose --dry-run up -d --no-build 2>&1)
if [[ "$up_plan" == *migrator* || "$up_plan" == *app-login* ]]; then
  echo 'Unqualified compose up unexpectedly plans a migrate-profile one-shot' >&2
  exit 1
fi

# Check the rendered volumes rather than relying on the empty database being pristine by accident.
compose config --format json | node -e '
const fs = require("fs");
const config = JSON.parse(fs.readFileSync(0, "utf8"));
if (config.services.postgres.volumes.some(volume => volume.target.startsWith("/docker-entrypoint-initdb.d"))) {
  throw new Error("staging postgres still runs initdb SQL");
}
'

scratch=$(mktemp -d)
cleanup() {
  compose --profile migrate down -v --remove-orphans
  # Best effort, only this run's scoped tags (api-server is built here; web-ui is never built).
  docker image rm "staging-happycmdb/api-server:${IMAGE_TAG}" "staging-happycmdb/web-ui:${IMAGE_TAG}" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

# Explicitly select only postgres: never start the other staging services in this disposable project.
compose up -d --wait postgres
compose build api-server
compose run --rm --no-deps migrator test -f /app/packages/database/src/postgres/migrations/001_complete_schema.sql
compose run --rm migrator

query_migrations() {
  compose exec -T postgres psql -X -A -t -v ON_ERROR_STOP=1 -U cmdb_user -d cmdb \
    -c 'SELECT migration_name FROM cmdb.schema_migrations ORDER BY migration_name'
}
query_migrations > "$scratch/actual"
find packages/database/src/postgres/migrations -maxdepth 1 -name '*.sql' -printf '%f\n' | sort > "$scratch/expected"
diff -u "$scratch/expected" "$scratch/actual"

compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U cmdb_user -d cmdb <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'itil_baselines' AND column_name = 'organization_id')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'cmdb' AND table_name = 'dim_ci' AND column_name = 'organization_id')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'discovery_agents' AND column_name = 'organization_id')
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'discovery_definitions' AND column_name = 'organization_id' AND is_nullable = 'YES')
    OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'discovery_definitions' AND indexname = 'idx_discovery_definitions_organization_id_id')
    OR to_regclass('public.dim_business_services') IS NULL
  THEN
    RAISE EXCEPTION 'required migrated schema missing';
  END IF;
END $$;
SQL

# HAP-1562: the API runs as cmdb_app (created by app-login before the migrator, granted by 045), not the owner.
owner_psql() { compose exec -T postgres psql -X -A -t -v ON_ERROR_STOP=1 -U cmdb_user -d cmdb "$@"; }
attrs=$(owner_psql -c "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
  FROM pg_roles WHERE rolname = 'cmdb_app'")
[ "$attrs" = 'f|f|f|f|f|t' ] || { echo "cmdb_app attributes: '$attrs'" >&2; exit 1; }
compose up -d --no-build --wait --wait-timeout 600 api-server
probe() { compose exec -T api-server node - < deploy/api-db-role-probe.cjs; }
app_probe=$(probe) || true
[ "$app_probe" = 'current_user=cmdb_app rolsuper=false' ] || { echo "API role probe: '$app_probe'" >&2; exit 1; }
sleep 20 # one journal sweeper tick (15 s) and the startup connector load, both as cmdb_app
# The loader and the sweeper log fixed text without the SQLSTATE, so match their failure lines too.
if compose logs api-server 2>&1 | grep -E '42501|permission denied|Failed to (load|register) connector|HP1 journal sweep failed'; then
  echo 'The API hit a privilege error as cmdb_app' >&2
  exit 1
fi
# The app login is refused DDL, role/database creation and superuser actions (42501 = insufficient_privilege).
while IFS= read -r statement; do
  # stdin from /dev/null: exec -T would otherwise consume the statement list.
  if refusal=$(compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -U cmdb_app -d cmdb \
    -c "$statement" < /dev/null 2>&1); then
    echo "cmdb_app was allowed: $statement" >&2
    exit 1
  fi
  [[ "$refusal" == *42501* ]] || { echo "cmdb_app refusal was not 42501: $statement: $refusal" >&2; exit 1; }
done <<'SQL'
CREATE TABLE public.hap1562_probe (id int)
CREATE SCHEMA hap1562_probe
ALTER TABLE ci_reconciliation_operations ADD COLUMN hap1562_probe int
DROP TABLE audit_log
TRUNCATE ci_reconciliation_operations
DELETE FROM audit_log
CREATE ROLE hap1562_probe
CREATE DATABASE hap1562_probe
ALTER ROLE cmdb_app SUPERUSER
ALTER SYSTEM SET log_statement = 'all'
COPY (SELECT 1) TO PROGRAM 'true'
SET ROLE cmdb_user
SQL

# Rollback (deploy/BUILD01-STAGING.md): the API back on the owner login; app-login skips and the migrator still runs.
rollback_env() (export POSTGRES_APP_USER=cmdb_user POSTGRES_APP_PASSWORD="$POSTGRES_PASSWORD"; "$@")
rollback_env compose up -d --no-build --no-deps --wait --wait-timeout 600 api-server
status=0
rolled_back=$(probe) || status=$?
[ "$rolled_back $status" = 'current_user=cmdb_user rolsuper=true 2' ] || {
  echo "rollback probe: '$rolled_back' exit $status" >&2; exit 1; }
rollback_env compose run --rm migrator

compose exec -T postgres psql -X -A -t -v ON_ERROR_STOP=1 -U cmdb_user -d cmdb \
  -c 'SELECT migration_name, checksum, applied_at FROM cmdb.schema_migrations ORDER BY migration_name' > "$scratch/before"
compose run --rm migrator
compose exec -T postgres psql -X -A -t -v ON_ERROR_STOP=1 -U cmdb_user -d cmdb \
  -c 'SELECT migration_name, checksum, applied_at FROM cmdb.schema_migrations ORDER BY migration_name' > "$scratch/after"
diff -u "$scratch/before" "$scratch/after"
compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U cmdb_user -d cmdb \
  -c "UPDATE cmdb.schema_migrations SET checksum = repeat('0', 64) WHERE migration_name = '001_complete_schema.sql'"
if compose run --rm migrator; then
  echo 'Migrator unexpectedly accepted a checksum mismatch' >&2
  exit 1
fi
echo 'Disposable empty-DB migration and no-op rerun passed'
