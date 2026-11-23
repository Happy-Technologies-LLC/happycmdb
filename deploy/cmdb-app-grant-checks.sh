# shellcheck shell=bash
# Sourced by deploy/test-staging-migrations.sh (the hosted `Staging Migration Contract` job). Each check takes plain files, so the
# PGlite test staging-app-login-receipts-grant.test.ts runs the very functions the job runs, on matrices it builds itself.
# No `set` options and no side effects on load: a check reports on stderr and returns 1.

# The objects of the current database (and the shared ones: databases, tablespaces) that cmdb_app owns, one description per line.
# pg_shdepend records every ownership, whatever the object kind (relation, schema, function, type, database ...).
cmdb_app_owned_objects_sql() {
  cat <<'SQL'
SELECT pg_describe_object(d.classid, d.objid, d.objsubid) AS owned
  FROM pg_shdepend d
 WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = 'cmdb_app'::regrole AND d.deptype = 'o'
   AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
 ORDER BY 1
SQL
}

# check_no_owned_objects <file>: <file> is the output of cmdb_app_owned_objects_sql. Fails naming each owned object: an owner
# holds every privilege on its object and can grant it onward, which no grant matrix row shows.
check_no_owned_objects() {
  [ -r "$1" ] || { echo "check_no_owned_objects: cannot read '$1'" >&2; return 1; }
  [ ! -s "$1" ] || {
    while IFS= read -r owned; do echo "cmdb_app owns $owned" >&2; done < "$1"
    echo 'cmdb_app must own nothing: reassign the objects to the owner login (REASSIGN OWNED BY cmdb_app TO cmdb_user)' >&2
    return 1
  }
}

# check_no_grant_option <matrix file>: no privilege may be held WITH GRANT OPTION (no migration or deploy SQL grants one).
check_no_grant_option() {
  [ -r "$1" ] || { echo "check_no_grant_option: cannot read '$1'" >&2; return 1; }
  if grep -q '|g$' "$1"; then
    echo 'cmdb_app holds a privilege WITH GRANT OPTION (it could re-grant it to any role):' >&2
    grep '|g$' "$1" >&2
    return 1
  fi
}

# check_matrix_allowlist <expected fixture> <matrix file>: every row of the matrix that is not an `f` (not held) row must be a row of
# the fixture and the other way round. Both files are LC_ALL=C sorted. An extra row is a grant nobody approved; a missing row is a
# grant a migration no longer gives (or the fixture lists by mistake).
check_matrix_allowlist() {
  [ -r "$1" ] && [ -r "$2" ] || { echo "check_matrix_allowlist: cannot read '$1' or '$2'" >&2; return 1; }
  local extra missing
  extra=$(LC_ALL=C comm --check-order -13 "$1" <(grep -v '|f$' "$2" || true)) || return 1
  missing=$(LC_ALL=C comm --check-order -23 "$1" <(grep -v '|f$' "$2" || true)) || return 1
  [ -z "$extra$missing" ] || {
    [ -z "$extra" ] || printf '%s\n' "$extra" | sed 's/^/extra grant (not in the expected cmdb_app grants): /' >&2
    [ -z "$missing" ] || printf '%s\n' "$missing" | sed 's/^/missing grant (expected, not held): /' >&2
    echo "cmdb_app's grants differ from $1. If a migration changed them on purpose, update that file as deploy/BUILD01-STAGING.md ('Updating the expected cmdb_app grants') describes." >&2
    return 1
  }
}
