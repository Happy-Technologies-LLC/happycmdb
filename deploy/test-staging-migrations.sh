#!/usr/bin/env bash
# Disposable CI-only proof; never point this at a staging Compose project or volume.
set -euo pipefail

cd "$(dirname "$0")/.."
# Postgres passwords (HAP-774 S5b C2): random hex per run, exported only to the Compose env, never echoed.
# The bootstrap superuser cmdb_user keeps POSTGRES_PASSWORD; the migrator logs in as cmdb_migration_owner and
# the api-server as happycmdb_app, each with its own variable.
for name in POSTGRES_PASSWORD CMDB_MIGRATION_OWNER_PASSWORD HAPPYCMDB_APP_POSTGRES_PASSWORD; do
  value=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')
  [[ "$value" =~ ^[0-9a-f]{64}$ ]] || { echo "could not generate $name" >&2; exit 1; }
  printf -v "$name" '%s' "$value"
  export "${name?}"
done
unset value
export NEO4J_PASSWORD=ci_disposable_password
export JWT_SECRET=ci_disposable_jwt
export JWT_ISSUER=ci_disposable_issuer
export JWT_AUDIENCE=ci_disposable_audience
export ENCRYPTION_KEY=ci_disposable_encryption_key
export AUDIT_CHAIN_KEY=ci_disposable_audit_chain_key
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

# HAP-774 S5b C2: a fresh volume has only the bootstrap superuser. As cmdb_user, provision what Phase A/B create on
# the live generation and C5 must create on a fresh Build01 one (role plan §1, §3.1; runbook v3 B3a) before the
# first migrator run: both roles, the owner's database/public grants, the app's CONNECT and public USAGE, and the
# two extensions (timescaledb is untrusted; uuid-ossp is pre-created so the owner does not own it). Passwords
# reach psql only on stdin (printf is a builtin: never in argv); VERBOSITY terse keeps statement text out of errors.
{
  printf "CREATE ROLE cmdb_migration_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 3 PASSWORD '%s';\n" "$CMDB_MIGRATION_OWNER_PASSWORD"
  printf "CREATE ROLE happycmdb_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 25 PASSWORD '%s';\n" "$HAPPYCMDB_APP_POSTGRES_PASSWORD"
  printf '%s\n' \
    'GRANT CONNECT, CREATE ON DATABASE cmdb TO cmdb_migration_owner;' \
    'GRANT USAGE, CREATE ON SCHEMA public TO cmdb_migration_owner;' \
    'GRANT CONNECT ON DATABASE cmdb TO happycmdb_app;' \
    'GRANT USAGE ON SCHEMA public TO happycmdb_app;' \
    'CREATE EXTENSION IF NOT EXISTS timescaledb;' \
    'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";'
} | compose exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=terse -U cmdb_user -d cmdb

compose run --rm migrator

# Schema cmdb exists only after 001: grant the app its USAGE now (runbook v3 B3a). Then prove the migrator really
# ran as cmdb_migration_owner: anything a superuser fallback created would be owned by cmdb_user.
compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U cmdb_user -d cmdb <<'SQL'
GRANT USAGE ON SCHEMA cmdb TO happycmdb_app;
DO $$
DECLARE
  mig_owner oid := 'cmdb_migration_owner'::regrole;
  foreign_owned int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE oid = mig_owner AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'cmdb_migration_owner must be a non-superuser, non-bypassrls login role';
  END IF;
  IF (SELECT nspowner FROM pg_namespace WHERE nspname = 'cmdb') IS DISTINCT FROM mig_owner
    OR (SELECT relowner FROM pg_class WHERE oid = to_regclass('cmdb.schema_migrations')) IS DISTINCT FROM mig_owner
    OR (SELECT relowner FROM pg_class WHERE oid = to_regclass('public.discovery_definition_migration_escrow')) IS DISTINCT FROM mig_owner
    OR (SELECT relowner FROM pg_class WHERE oid = to_regclass('public.discovery_definition_migrations')) IS DISTINCT FROM mig_owner
  THEN
    RAISE EXCEPTION 'schema cmdb, cmdb.schema_migrations, the S5b ledger or escrow is not owned by cmdb_migration_owner';
  END IF;
  -- Role plan §2.2 scope: relations, functions/procedures and free-standing types in public/cmdb, extension members excluded.
  SELECT count(*) INTO foreign_owned FROM (
    SELECT c.oid, c.relowner AS objowner, 'pg_class'::regclass AS catalog_id FROM pg_class c
     WHERE c.relnamespace IN ('public'::regnamespace, 'cmdb'::regnamespace) AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    UNION ALL
    SELECT p.oid, p.proowner, 'pg_proc'::regclass FROM pg_proc p
     WHERE p.pronamespace IN ('public'::regnamespace, 'cmdb'::regnamespace)
    UNION ALL
    SELECT t.oid, t.typowner, 'pg_type'::regclass FROM pg_type t
     WHERE t.typnamespace IN ('public'::regnamespace, 'cmdb'::regnamespace) AND t.typtype IN ('e', 'd', 'r', 'm')
  ) o
  WHERE o.objowner <> mig_owner
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = o.catalog_id AND d.objid = o.oid AND d.deptype = 'e');
  IF foreign_owned <> 0 THEN
    RAISE EXCEPTION '% migrated objects in public/cmdb are not owned by cmdb_migration_owner', foreign_owned;
  END IF;
END $$;
SQL

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
