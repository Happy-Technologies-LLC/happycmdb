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

# Inspect the actual unqualified up plan without creating any services. The plan is captured, so a failing compose must
# report its own output and exit status: under `set -e` a bare `up_plan=$(...)` exits silently with compose's status.
up_plan_status=0
up_plan=$(compose --dry-run up -d --no-build 2>&1) || up_plan_status=$?
if [ "$up_plan_status" -ne 0 ]; then
  echo "compose --dry-run up failed with exit status $up_plan_status:" >&2
  printf '%s\n' "$up_plan" >&2
  exit 1
fi
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
# What a finished install looks like to the app login: its grants and every column of the application schemas.
app_state() {
  owner_psql -c "
    SELECT 'rel ' || n.nspname || '.' || c.relname || ' ' || a.privilege_type
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
      WHERE a.grantee = 'cmdb_app'::regrole AND n.nspname IN ('public', 'cmdb')
    UNION ALL
    SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a
      WHERE a.grantee = 'cmdb_app'::regrole
    UNION ALL
    SELECT 'col ' || table_schema || '.' || table_name || '.' || column_name || ' ' || data_type
      FROM information_schema.columns WHERE table_schema IN ('public', 'cmdb')
    ORDER BY 1"
}
app_state > "$scratch/fresh_state"
[ "$(grep -c '^rel ' "$scratch/fresh_state")" -gt 0 ] || { echo 'cmdb_app holds no grants after a fresh install' >&2; exit 1; }
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

# HAP-1575: the generation-94 shape (ledger present, no 045, no cmdb_app) upgrades to the fresh-install end state.
# Rebuild the volume, then migrate with only the files before 045 and without app-login (--no-deps), so cmdb_app is never made.
compose --profile migrate down -v --remove-orphans
compose up -d --wait postgres
gen94="$scratch/gen94-migrations"
mkdir "$gen94"
for file in packages/database/src/postgres/migrations/*.sql; do
  if [[ "$(basename "$file")" < 045_staging_app_login_acl.sql ]]; then cp "$file" "$gen94/"; fi
done
ls "$gen94" > "$scratch/gen94_expected"
[ -s "$scratch/gen94_expected" ] && ! grep -q '^045' "$scratch/gen94_expected"
compose run --rm --no-deps -v "$gen94:/gen94:ro" migrator \
  node packages/database/dist/postgres/run-migrations.js /gen94
query_migrations > "$scratch/actual"
diff -u "$scratch/gen94_expected" "$scratch/actual"
roles=$(owner_psql -c "SELECT count(*) FROM pg_roles WHERE rolname = 'cmdb_app'")
[ "$roles" = 0 ] || { echo "generation-94 fixture already has cmdb_app" >&2; exit 1; }

# Same checks after an upgrade and after a down + re-up: ledger complete, the app login a plain LOGIN role, grants and schema as a
# fresh install, and the API connecting as cmdb_app.
assert_fresh_end_state() {
  query_migrations > "$scratch/actual"
  diff -u "$scratch/expected" "$scratch/actual"
  attrs=$(owner_psql -c "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
    FROM pg_roles WHERE rolname = 'cmdb_app'")
  [ "$attrs" = 'f|f|f|f|f|t' ] || { echo "$1: cmdb_app attributes: '$attrs'" >&2; exit 1; }
  app_state > "$scratch/state"
  diff -u "$scratch/fresh_state" "$scratch/state"
  compose up -d --no-build --wait --wait-timeout 600 api-server
  app_probe=$(probe) || true
  [ "$app_probe" = 'current_user=cmdb_app rolsuper=false' ] || { echo "$1: API role probe: '$app_probe'" >&2; exit 1; }
}
compose run --rm migrator
assert_fresh_end_state 'generation-94 upgrade'

# The manual 045 rollback sets cmdb_app NOLOGIN; the next app-login + migrator run restores LOGIN and re-applies 045-048.
compose stop api-server
for _ in $(seq 30); do
  sessions=$(owner_psql -c "SELECT count(*) FROM pg_stat_activity WHERE usename = 'cmdb_app'")
  [ "$sessions" = 0 ] && break
  sleep 1
done
[ "$sessions" = 0 ] || { echo 'cmdb_app sessions outlived the API' >&2; exit 1; }
compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U cmdb_user -d cmdb \
  < packages/database/src/postgres/migrations/rollback/045_staging_app_login_acl.down.sql
down_login=$(owner_psql -c "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'cmdb_app'")
[ "$down_login" = f ] || { echo "cmdb_app rolcanlogin after the 045 rollback: '$down_login'" >&2; exit 1; }
down_grants=$(app_state | grep -E '^(rel|schema) ' || true)
[ -z "$down_grants" ] || { echo "cmdb_app kept grants after the 045 rollback: $down_grants" >&2; exit 1; }
if refusal=$(compose exec -T postgres psql -X -U cmdb_app -d cmdb -c 'SELECT 1' < /dev/null 2>&1); then
  echo 'cmdb_app logged in after the 045 rollback' >&2
  exit 1
fi
[[ "$refusal" == *'not permitted to log in'* ]] || { echo "cmdb_app refusal was not NOLOGIN: $refusal" >&2; exit 1; }
compose run --rm migrator
assert_fresh_end_state 'down + re-up'
echo 'Disposable generation-94 upgrade and 045 rollback + re-up passed'

# shellcheck source=deploy/cmdb-app-grant-checks.sh
source deploy/cmdb-app-grant-checks.sh
# HAP-2126: a cmdb_app dropped and re-created by app-login (045 plus the per-table grants of 046-048, 054 and 056, re-applied
# because the migrator never re-runs a recorded migration) must hold exactly what it holds after a fresh migration. The
# matrix is every privilege of cmdb_app on every relation, schema and function of public and cmdb, the column-only
# privileges (held on a column, not on its table: has_table_privilege ignores column ACLs; a column grant option under a table
# grant without one counts too), the default privileges that name cmdb_app (as grantee or as the role they apply to) and the
# database privileges. The last field is g (held WITH GRANT OPTION), t (held without it) or f (not held). A function that belongs
# to an extension (timescaledb, uuid-ossp: their set changes with the extension version) is listed only when cmdb_app holds an
# ACL entry on it of its own. Keep the SQL identical to grantMatrixSql() in staging-app-login-receipts-grant.test.ts apart from
# the role literal (that test compares the two texts).
grant_matrix() {
  owner_psql -c "
    SELECT n.nspname || '.' || c.relname || '|' || p.privilege || '|'
        || CASE WHEN CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('cmdb_app', c.oid, p.privilege || ' WITH GRANT OPTION')
                     ELSE has_table_privilege('cmdb_app', c.oid, p.privilege || ' WITH GRANT OPTION') END THEN 'g'
                WHEN CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('cmdb_app', c.oid, p.privilege)
                     ELSE has_table_privilege('cmdb_app', c.oid, p.privilege) END THEN 't' ELSE 'f' END AS row
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL unnest(CASE WHEN c.relkind = 'S' THEN ARRAY['USAGE', 'SELECT', 'UPDATE']
        ELSE ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] END) AS p(privilege)
      WHERE n.nspname IN ('public', 'cmdb') AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
    UNION ALL
    SELECT 'schema ' || n.nspname || '|' || p.privilege || '|'
        || CASE WHEN has_schema_privilege('cmdb_app', n.oid, p.privilege || ' WITH GRANT OPTION') THEN 'g'
                WHEN has_schema_privilege('cmdb_app', n.oid, p.privilege) THEN 't' ELSE 'f' END
      FROM pg_namespace n CROSS JOIN (VALUES ('USAGE'), ('CREATE')) AS p(privilege) WHERE n.nspname IN ('public', 'cmdb')
    UNION ALL
    SELECT 'function ' || f.oid::regprocedure::text || '|EXECUTE|'
        || CASE WHEN has_function_privilege('cmdb_app', f.oid, 'EXECUTE WITH GRANT OPTION') THEN 'g'
                WHEN has_function_privilege('cmdb_app', f.oid, 'EXECUTE') THEN 't' ELSE 'f' END
      FROM pg_proc f JOIN pg_namespace n ON n.oid = f.pronamespace WHERE n.nspname IN ('public', 'cmdb')
        AND (NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_proc'::regclass AND e.objid = f.oid AND e.deptype = 'e')
             OR EXISTS (SELECT 1 FROM aclexplode(f.proacl) a JOIN pg_roles r ON r.oid = a.grantee WHERE r.rolname = 'cmdb_app'))
    UNION ALL
    SELECT 'column ' || n.nspname || '.' || c.relname || '.' || a.attname || '|' || p.privilege || '|'
        || CASE WHEN has_column_privilege('cmdb_app', a.attrelid, a.attnum, p.privilege || ' WITH GRANT OPTION') THEN 'g' ELSE 't' END
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(privilege)
      WHERE n.nspname IN ('public', 'cmdb') AND c.relkind IN ('r', 'p', 'v', 'm') AND a.attnum > 0 AND NOT a.attisdropped
        AND ((has_column_privilege('cmdb_app', a.attrelid, a.attnum, p.privilege)
              AND NOT has_table_privilege('cmdb_app', a.attrelid, p.privilege))
             OR (has_column_privilege('cmdb_app', a.attrelid, a.attnum, p.privilege || ' WITH GRANT OPTION')
                 AND NOT has_table_privilege('cmdb_app', a.attrelid, p.privilege || ' WITH GRANT OPTION')))
    UNION ALL
    SELECT 'default_acl ' || r.rolname || ' ' || coalesce(n.nspname, '*') || ' ' || d.defaclobjtype::text || '|'
        || coalesce(g.rolname, 'PUBLIC') || '|' || x.privilege_type || '|' || CASE WHEN x.is_grantable THEN 'g' ELSE 't' END
      FROM pg_default_acl d JOIN pg_roles r ON r.oid = d.defaclrole LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) x LEFT JOIN pg_roles g ON g.oid = x.grantee
      WHERE r.rolname = 'cmdb_app' OR g.rolname = 'cmdb_app'
    UNION ALL
    SELECT 'database ' || current_database() || '|' || p.privilege || '|'
        || CASE WHEN has_database_privilege('cmdb_app', current_database(), p.privilege || ' WITH GRANT OPTION') THEN 'g'
                WHEN has_database_privilege('cmdb_app', current_database(), p.privilege) THEN 't' ELSE 'f' END
      FROM (VALUES ('CONNECT'), ('CREATE'), ('TEMP')) AS p(privilege)" | LC_ALL=C sort
}
grant_matrix > "$scratch/matrix_baseline"
# Non-empty and carrying the six per-table grants of the app-login block, so an empty diff cannot pass.
[ "$(wc -l < "$scratch/matrix_baseline")" -gt 100 ] || { echo 'cmdb_app grant matrix is unexpectedly small' >&2; exit 1; }
# cmdb_app owns nothing (an owner needs no grant and can grant onward), holds no grant option, and holds exactly the grants of
# the expected-grants fixture (a drift in either direction fails, naming the rows). Checks: deploy/cmdb-app-grant-checks.sh.
owner_psql -c "$(cmdb_app_owned_objects_sql)" > "$scratch/cmdb_app_owned"
check_no_owned_objects "$scratch/cmdb_app_owned" || exit 1
check_no_grant_option "$scratch/matrix_baseline" || exit 1
check_matrix_allowlist deploy/cmdb-app-grants.expected "$scratch/matrix_baseline" || exit 1
for entry in service_offerings:SELECT,INSERT,UPDATE ai_sync_cursors:SELECT,INSERT,UPDATE portfolio_imports:SELECT,INSERT \
  portfolio_import_map:SELECT,INSERT relationship_evidence_receipts:SELECT,INSERT estate_kpi_snapshots:SELECT,INSERT; do
  for privilege in SELECT INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER; do
    expected=f
    case ",${entry#*:}," in *",$privilege,"*) expected=t ;; esac
    grep -qxF "public.${entry%%:*}|$privilege|$expected" "$scratch/matrix_baseline" \
      || { echo "baseline matrix lacks public.${entry%%:*}|$privilege|$expected" >&2; exit 1; }
  done
done
compose stop api-server
for _ in $(seq 30); do
  sessions=$(owner_psql -c "SELECT count(*) FROM pg_stat_activity WHERE usename = 'cmdb_app'")
  [ "$sessions" = 0 ] && break
  sleep 1
done
[ "$sessions" = 0 ] || { echo 'cmdb_app sessions outlived the API' >&2; exit 1; }
owner_psql -c 'DROP OWNED BY cmdb_app; DROP ROLE cmdb_app'
[ "$(owner_psql -c "SELECT count(*) FROM pg_roles WHERE rolname = 'cmdb_app'")" = 0 ] \
  || { echo 'cmdb_app survived DROP ROLE' >&2; exit 1; }
compose run --rm migrator
grant_matrix > "$scratch/matrix_recreated"
if ! diff -u "$scratch/matrix_baseline" "$scratch/matrix_recreated"; then
  echo 'A re-created cmdb_app differs from a freshly migrated one (rows above: - fresh, + re-created)' >&2
  exit 1
fi
echo 'Disposable cmdb_app re-creation equals a fresh install'
