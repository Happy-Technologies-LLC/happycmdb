#!/usr/bin/env bash
# Disposable CI-only proof; never point this at a staging Compose project or volume.
set -euo pipefail

cd "$(dirname "$0")/.."
export POSTGRES_PASSWORD=ci_disposable_password
export NEO4J_PASSWORD=ci_disposable_password
export JWT_SECRET=ci_disposable_jwt
export JWT_ISSUER=ci_disposable_issuer
export JWT_AUDIENCE=ci_disposable_audience
export ENCRYPTION_KEY=ci_disposable_encryption_key
export STAGING_PUBLIC_URL=https://ci.invalid
export COMPOSE_PROJECT_NAME="stg-mig-ci-${GITHUB_RUN_ID:?CI only}-${GITHUB_RUN_ATTEMPT:?CI only}"

compose() { docker compose -f deploy/build01-staging.compose.yml "$@"; }
services=$(compose config --services)
if printf '%s\n' "$services" | grep -qx migrator; then
  echo 'Default compose services unexpectedly include migrator' >&2
  exit 1
fi
compose --profile migrate config --services | grep -qx migrator

# Inspect the actual unqualified up plan without creating any services.
up_plan=$(compose --dry-run up -d --no-build 2>&1)
if [[ "$up_plan" == *migrator* ]]; then
  echo 'Unqualified compose up unexpectedly plans migrator' >&2
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
    OR to_regclass('public.dim_business_services') IS NULL
  THEN
    RAISE EXCEPTION 'required migrated schema missing';
  END IF;
END $$;
SQL

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
