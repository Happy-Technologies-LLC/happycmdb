#!/bin/bash
#
# PostgreSQL Restore Script for HappyCMDB
# Supports restore from compressed backups with verification
#

set -euo pipefail

# Configuration from environment variables or defaults
BACKUP_DIR="${BACKUP_DIR:-/var/backups/happycmdb/postgres}"
POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DATABASE="${POSTGRES_DATABASE:-cmdb}"
POSTGRES_USER="${POSTGRES_USER:-cmdb_user}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-}"

# Restore options
RESTORE_DROP_DATABASE="${RESTORE_DROP_DATABASE:-false}"
RESTORE_CREATE_DATABASE="${RESTORE_CREATE_DATABASE:-true}"
# HAP-1762: replacing an existing database is argv-only (--replace-live with --pre-restore-backup FILE); no
# environment variable enables it.
REPLACE_LIVE=false
PRE_RESTORE_BACKUP=""
PREFLIGHT_ONLY=false
REUSE_PRE_RESTORE_BACKUP=false
VERIFIED_TABLES=0
# Printed as its own line when a preflight passes; rollback.sh refuses a restore script that does not print it.
PREFLIGHT_MARKER="HAP-1762 PREFLIGHT OK"

# Logging functions
log_info() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] INFO: $*"
}

log_error() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
}

log_success() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] SUCCESS: $*"
}

log_warning() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $*"
}

# Display usage
usage() {
    cat <<EOF
Usage: $0 [OPTIONS]

Restore PostgreSQL database from backup.

OPTIONS:
    -f, --file FILE         Backup file to restore (required)
    -d, --database NAME     Target database name (default: ${POSTGRES_DATABASE})
    -h, --host HOST         PostgreSQL host (default: ${POSTGRES_HOST})
    -p, --port PORT         PostgreSQL port (default: ${POSTGRES_PORT})
    -u, --user USER         PostgreSQL user (default: ${POSTGRES_USER})
    --drop                  Drop existing database before restore
    --no-create             Don't create database (assume it exists)
    --verify                Verify restore: every table's row count must match the backup
    --replace-live          Replace an existing database: refuse while another client is connected, take and verify
                            a pre-restore backup, DROP, CREATE, load, verify (requires --pre-restore-backup)
    --pre-restore-backup F  Where --replace-live writes the backup of the current database; F must not exist yet
    --reuse-pre-restore-backup  Load over the live database with the existing F instead (rollback.sh only, after
                            its own preflight wrote F in the same run)
    --preflight             Run the checks (and with --replace-live take the pre-restore backup), change nothing
    --help                  Display this help message

EXAMPLES:
    # List available backups
    $0 --list

    # Restore latest daily backup
    $0 --file \$(ls -t ${BACKUP_DIR}/daily/*.sql.gz | head -1)

    # Restore specific backup with database drop
    $0 --file /path/to/backup.sql.gz --drop --verify

    # Restore to different database
    $0 --file backup.sql.gz --database cmdb_test
EOF
    exit 0
}

# List available backups
list_backups() {
    log_info "Available backups:"
    echo ""
    echo "=== Daily Backups ==="
    ls -lh "${BACKUP_DIR}/daily"/*.sql.gz 2>/dev/null | awk '{print $9, "("$5")", $6, $7, $8}' || echo "No daily backups found"
    echo ""
    echo "=== Weekly Backups ==="
    ls -lh "${BACKUP_DIR}/weekly"/*.sql.gz 2>/dev/null | awk '{print $9, "("$5")", $6, $7, $8}' || echo "No weekly backups found"
    echo ""
    echo "=== Monthly Backups ==="
    ls -lh "${BACKUP_DIR}/monthly"/*.sql.gz 2>/dev/null | awk '{print $9, "("$5")", $6, $7, $8}' || echo "No monthly backups found"
    echo ""
    exit 0
}

# Verify backup file
verify_backup_file() {
    local backup_file="$1"

    log_info "Verifying backup file: ${backup_file}"

    if [[ ! -f "${backup_file}" ]]; then
        log_error "Backup file does not exist: ${backup_file}"
        exit 1
    fi

    # Test gzip integrity
    if gzip -t "${backup_file}"; then
        log_success "Backup file integrity verified"
    else
        log_error "Backup file is corrupted"
        exit 1
    fi
    if ! dump_complete "${backup_file}"; then
        log_error "Backup file is incomplete: no pg_dump completion line"
        exit 1
    fi

    # Get file size
    local file_size=$(du -h "${backup_file}" | cut -f1)
    log_info "Backup file size: ${file_size}"
}

# Check database connection
check_connection() {
    log_info "Checking database connection..."

    export PGPASSWORD="${POSTGRES_PASSWORD}"

    if psql -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -U "${POSTGRES_USER}" -d postgres -c "SELECT 1" > /dev/null 2>&1; then
        log_success "Database connection successful"
    else
        log_error "Cannot connect to database server"
        exit 1
    fi

    unset PGPASSWORD
}

# Drop database if exists
drop_database() {
    log_warning "Dropping database '${POSTGRES_DATABASE}' if it exists..."

    export PGPASSWORD="${POSTGRES_PASSWORD}"

    # Terminate active connections
    psql -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -U "${POSTGRES_USER}" -d postgres -c \
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${POSTGRES_DATABASE}' AND pid <> pg_backend_pid();" \
        > /dev/null 2>&1 || true

    # Drop database
    psql -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -U "${POSTGRES_USER}" -d postgres -c \
        "DROP DATABASE IF EXISTS ${POSTGRES_DATABASE};" || log_error "Failed to drop database"

    unset PGPASSWORD

    log_success "Database dropped"
}

# Create database
create_database() {
    log_info "Creating database '${POSTGRES_DATABASE}'..."

    export PGPASSWORD="${POSTGRES_PASSWORD}"

    psql -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -U "${POSTGRES_USER}" -d postgres -c \
        "CREATE DATABASE ${POSTGRES_DATABASE};" || {
        log_error "Failed to create database"
        exit 1
    }

    unset PGPASSWORD

    log_success "Database created"
}

# psql for one statement: no psqlrc, unaligned tuples only, stop on error; the password via the environment, never argv.
pg_query() {
    PGPASSWORD="${POSTGRES_PASSWORD}" psql -X -At -v ON_ERROR_STOP=1 -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" \
        -U "${POSTGRES_USER}" -d "$1" -c "$2" < /dev/null
}

# pg_dump's plain format ends with "-- PostgreSQL database dump complete"; since 13.22/14.19/15.14/16.10/17.6 it is
# followed by a "\unrestrict <key>" line. Complete iff that line is the last one that is not blank, "--" or \unrestrict.
dump_complete() {
    local last_lines
    last_lines=$(gunzip -c "$1" | tail -n 12 | grep -v -e '^$' -e '^--$' -e '^\\unrestrict ') || return 1
    [[ "${last_lines##*$'\n'}" == '-- PostgreSQL database dump complete' ]]
}

# Load the plain dump into the target. Success is the pipeline's own status (pipefail, set above): gunzip and psql must
# both exit 0, and nothing filters the output on the way. ON_ERROR_STOP stops psql (exit 3) at the first SQL error and
# --single-transaction rolls the whole load back. A TimescaleDB dump is loaded between timescaledb_pre_restore() and
# timescaledb_post_restore(). Returns non-zero on any failure; the caller decides the exit code.
perform_restore() {
    local backup_file="$1"
    local timescale load_log

    log_info "Starting restore process..."
    log_info "Backup file: ${backup_file}"
    log_info "Target database: ${POSTGRES_DATABASE}"
    log_info "Host: ${POSTGRES_HOST}:${POSTGRES_PORT}"

    local start_time=$(date +%s)

    timescale=$(gunzip -c "${backup_file}" | grep -c '^CREATE EXTENSION IF NOT EXISTS timescaledb') || true
    if [[ "${timescale}" -gt 0 ]]; then
        if ! pg_query "${POSTGRES_DATABASE}" "CREATE EXTENSION IF NOT EXISTS timescaledb" > /dev/null \
            || ! pg_query "${POSTGRES_DATABASE}" "SELECT timescaledb_pre_restore()" > /dev/null; then
            log_error "timescaledb_pre_restore() failed - nothing was loaded"
            return 1
        fi
    fi

    load_log=$(mktemp)
    if ! gunzip -c "${backup_file}" | PGPASSWORD="${POSTGRES_PASSWORD}" psql -X -q -v ON_ERROR_STOP=1 --single-transaction \
        -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -U "${POSTGRES_USER}" -d "${POSTGRES_DATABASE}" > "${load_log}" 2>&1; then
        log_error "Load failed and was rolled back; last psql output:"
        tail -n 20 "${load_log}" >&2
        rm -f "${load_log}"
        return 1
    fi
    rm -f "${load_log}"

    if [[ "${timescale}" -gt 0 ]] && ! pg_query "${POSTGRES_DATABASE}" "SELECT timescaledb_post_restore()" > /dev/null; then
        log_error "timescaledb_post_restore() failed after the load"
        return 1
    fi

    local end_time=$(date +%s)
    log_success "Load completed in $((end_time - start_time)) seconds"
}

# Every table the dump carries data for must hold exactly the backup's row count. ONLY: a hypertable parent's COPY block
# is empty in a plain dump and its rows are counted in the chunk tables' own blocks. TimescaleDB's catalog/config
# tables are maintained by the extension and are not compared. Sets VERIFIED_TABLES; returns non-zero on any mismatch.
verify_restore() {
    local backup_file="$1"
    local expected table actual checked=0 mismatched=0

    log_info "Verifying restore: row count per table against the backup..."
    while read -r expected table; do
        if ! actual=$(pg_query "${POSTGRES_DATABASE}" "SELECT count(*) FROM ONLY ${table}"); then
            actual="(count failed)"
        fi
        if [[ "${actual}" != "${expected}" ]]; then
            log_error "${table}: backup has ${expected} rows, restored database has ${actual}"
            mismatched=$((mismatched + 1))
        fi
        checked=$((checked + 1))
    done < <(gunzip -c "${backup_file}" | awk '
        copying { if ($0 == "\\.") { if (!skip) print rows, table; copying = 0 } else rows++; next }
        /^COPY .* FROM stdin;$/ {
            table = $0; sub(/^COPY /, "", table); sub(/ (\(.*\) )?FROM stdin;$/, "", table)
            skip = (table ~ /^_timescaledb_(catalog|config)\./); copying = 1; rows = 0
        }')

    if [[ "${mismatched}" -gt 0 ]]; then
        log_error "${mismatched} of ${checked} tables do not match the backup"
        return 1
    fi
    VERIFIED_TABLES=${checked}
    if [[ "${checked}" -eq 0 ]]; then
        log_warning "No data tables compared: the backup has no table data"
    else
        log_success "Row counts match the backup for ${checked} tables"
    fi
}

# A restore never brings back GRANT/REVOKE: backup-postgres.sh dumps with --no-acl. The restoring login owns every
# restored object; every other login's privileges and the PUBLIC EXECUTE revokes must be re-applied from the migrations.
# Printed for the operator, never run here.
print_grant_step() {
    local conn="-h ${POSTGRES_HOST} -p ${POSTGRES_PORT} -U ${POSTGRES_USER} -d ${POSTGRES_DATABASE}"
    local acl_migrations="'032_secret_table_public_grants.sql', '033_public_business_service_audit_acl.sql', '039_recent_audit_activity_acl.sql', '044_business_service_journal_read_acl.sql', '045_staging_app_login_acl.sql', '046_service_offerings.sql', '047_ai_sync_cursors.sql', '048_portfolio_import.sql'"
    cat <<EOF

MANDATORY POST-RESTORE GRANT STEP - grants NOT restored (the backup was taken with --no-acl).
  ${POSTGRES_USER} now owns every restored object. Missing until re-applied: cmdb_app (045-048), metabase_readonly
  (032, 033, 039), cmdb_user where it is not ${POSTGRES_USER} (033, 034, 039, 044, 046-048), and the PUBLIC EXECUTE
  revokes (010, 041). As ${POSTGRES_USER}, PGPASSWORD exported, from a checkout of the commit the backup was taken at:
  1) Re-apply the idempotent ACL migrations that the restored ledger records:
     for m in \$(psql -XAt ${conn} -c "SELECT migration_name FROM cmdb.schema_migrations WHERE migration_name IN (${acl_migrations}) ORDER BY 1"); do psql -X -v ON_ERROR_STOP=1 --single-transaction ${conn} -f "packages/database/src/postgres/migrations/\$m" || break; done
  2) Re-revoke PUBLIC EXECUTE (010, 041):
     psql -X -v ON_ERROR_STOP=1 ${conn} -c "DO \\\$g\\\$ DECLARE f text; BEGIN FOREACH f IN ARRAY ARRAY['cmdb.fn_business_service_health(uuid)', 'cmdb.fn_tbm_tower_summary(uuid)', 'discovery_definition_migrations_append_only()'] LOOP IF to_regprocedure(f) IS NOT NULL THEN EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f); END IF; END LOOP; END \\\$g\\\$"
  3) Only if 034 is recorded and cmdb_user is not ${POSTGRES_USER} (034 cannot be re-run: its guard table is restored):
     psql -X -v ON_ERROR_STOP=1 --single-transaction ${conn} -c "GRANT SELECT, INSERT ON public.ci_change_history TO cmdb_user; GRANT USAGE ON ALL SEQUENCES IN SCHEMA cmdb TO cmdb_user; GRANT SELECT, INSERT ON cmdb.dim_ci, cmdb.dim_location, cmdb.dim_owner, cmdb.fact_discovery, cmdb.fact_ci_changes, cmdb.fact_ci_relationships TO cmdb_user; GRANT SELECT, INSERT, UPDATE, DELETE ON public.discovery_agents TO cmdb_user; GRANT SELECT ON public.active_discovery_agents, public.agent_network_coverage TO cmdb_user"
  Then restart the services that log in as those roles. Runbook: infrastructure/docs/DEPLOYMENT_RUNBOOK.md, "Post-restore grants".
EOF
}

# Exit 1: refuse while any other client session is on the target. Nothing is terminated.
refuse_if_other_clients() {
    local clients
    if ! clients=$(pg_query postgres "SELECT usename || ' ' || coalesce(application_name, '') || ' ' || coalesce(client_addr::text, 'local') FROM pg_stat_activity WHERE datname = '${POSTGRES_DATABASE}' AND backend_type = 'client backend' AND pid <> pg_backend_pid()"); then
        log_error "Cannot list the sessions on '${POSTGRES_DATABASE}' - nothing was changed"
        exit 1
    fi
    if [[ -n "${clients}" ]]; then
        log_error "Other client sessions are connected to '${POSTGRES_DATABASE}' - stop them first; nothing was terminated or changed:"
        sed 's/^/    /' <<< "${clients}" >&2
        exit 1
    fi
}

# Exit 1 unless PRE_RESTORE_BACKUP is a complete, readable dump of the current database. An absent file is taken now
# (mode 0600 via umask). An existing F is never trusted as a copy of the current state: refused, unless rollback.sh
# passes --reuse-pre-restore-backup for the F its own preflight wrote in this run.
take_pre_restore_backup() {
    if [[ -e "${PRE_RESTORE_BACKUP}" && "${REUSE_PRE_RESTORE_BACKUP}" != "true" ]]; then
        log_error "Pre-restore backup ${PRE_RESTORE_BACKUP} already exists - give a new path; nothing was changed"
        exit 1
    elif [[ -e "${PRE_RESTORE_BACKUP}" ]]; then
        log_info "Reusing the pre-restore backup this rollback's preflight wrote: ${PRE_RESTORE_BACKUP}"
    else
        log_info "Taking the pre-restore backup of '${POSTGRES_DATABASE}': ${PRE_RESTORE_BACKUP}"
        mkdir -p "$(dirname "${PRE_RESTORE_BACKUP}")"
        if ! (umask 077; PGPASSWORD="${POSTGRES_PASSWORD}" pg_dump -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -U "${POSTGRES_USER}" \
            -d "${POSTGRES_DATABASE}" --format=plain | gzip > "${PRE_RESTORE_BACKUP}"); then
            rm -f "${PRE_RESTORE_BACKUP}"
            log_error "Pre-restore backup failed - nothing was dropped; '${POSTGRES_DATABASE}' is untouched"
            exit 1
        fi
    fi
    if ! gzip -t "${PRE_RESTORE_BACKUP}" || ! dump_complete "${PRE_RESTORE_BACKUP}"; then
        log_error "Pre-restore backup ${PRE_RESTORE_BACKUP} is not a complete, readable dump - nothing was dropped; '${POSTGRES_DATABASE}' is untouched"
        exit 1
    fi
    log_success "Pre-restore backup verified: ${PRE_RESTORE_BACKUP}"
}

# Exit with code $1 after a change was made, naming the state ($2) and, when one was taken, how to put the
# pre-restore backup back.
restore_failed() {
    log_error "Restore FAILED (exit $1): $2 - do not start the app on it"
    if [[ -n "${PRE_RESTORE_BACKUP}" && -e "${PRE_RESTORE_BACKUP}" ]]; then
        log_error "Pre-restore backup: ${PRE_RESTORE_BACKUP}"
        log_error "To put it back (POSTGRES_PASSWORD exported): POSTGRES_HOST=${POSTGRES_HOST} POSTGRES_PORT=${POSTGRES_PORT} POSTGRES_USER=${POSTGRES_USER} bash $0 --database ${POSTGRES_DATABASE} --replace-live --file ${PRE_RESTORE_BACKUP} --pre-restore-backup ${PRE_RESTORE_BACKUP%.sql.gz}-return-$(date +%Y%m%d-%H%M%S).sql.gz < /dev/null"
    fi
    exit "$1"
}

# HAP-1762: replace an existing database. No other client, a verified pre-restore backup (--preflight stops here), no
# other client again, DROP (no FORCE: PostgreSQL itself refuses while a session is connected), CREATE, load, verify.
# Exit 1: nothing changed. Exit 3: dropped, then CREATE or the load failed (the database is absent or empty).
# Exit 4: loaded, but the row counts differ from the backup.
replace_live() {
    local backup_file="$1" database_exists="$2"

    if [[ "${database_exists}" == "true" ]]; then
        refuse_if_other_clients
        take_pre_restore_backup
    else
        log_warning "Database '${POSTGRES_DATABASE}' does not exist: nothing to back up or drop"
    fi
    if [[ "${PREFLIGHT_ONLY}" == "true" ]]; then
        log_success "Preflight passed - nothing was changed"
        echo "${PREFLIGHT_MARKER}"
        exit 0
    fi

    if [[ -t 0 ]]; then
        confirm_restore "${backup_file}"
    fi

    if [[ "${database_exists}" == "true" ]]; then
        refuse_if_other_clients
        log_warning "Dropping database '${POSTGRES_DATABASE}' (pre-restore backup: ${PRE_RESTORE_BACKUP})"
        if ! pg_query postgres "DROP DATABASE ${POSTGRES_DATABASE}" > /dev/null; then
            log_error "DROP DATABASE failed - '${POSTGRES_DATABASE}' is untouched"
            exit 1
        fi
    fi
    if ! pg_query postgres "CREATE DATABASE ${POSTGRES_DATABASE}" > /dev/null; then
        restore_failed 3 "CREATE DATABASE failed: '${POSTGRES_DATABASE}' does not exist"
    fi
    perform_restore "${backup_file}" || restore_failed 3 "the load did not complete: '${POSTGRES_DATABASE}' is empty or incomplete"
    verify_restore "${backup_file}" || restore_failed 4 "'${POSTGRES_DATABASE}' is loaded but does NOT match the backup"

    local verified="${VERIFIED_TABLES} tables verified"
    [[ "${VERIFIED_TABLES}" -eq 0 ]] && verified="no data tables compared"
    log_success "Restore completed: '${POSTGRES_DATABASE}' replaced from ${backup_file}, ${verified} - grants NOT restored"
    print_grant_step
}

# Request confirmation
confirm_restore() {
    local backup_file="$1"

    echo ""
    log_warning "=== RESTORE CONFIRMATION ==="
    log_warning "Backup file: ${backup_file}"
    log_warning "Target database: ${POSTGRES_DATABASE}"
    log_warning "Host: ${POSTGRES_HOST}:${POSTGRES_PORT}"

    if [[ "${RESTORE_DROP_DATABASE}" == "true" || "${REPLACE_LIVE}" == "true" ]]; then
        log_warning "WARNING: Existing database will be DROPPED!"
    fi

    echo ""
    read -p "Are you sure you want to proceed? (yes/no): " confirmation

    if [[ "${confirmation}" != "yes" ]]; then
        log_info "Restore cancelled by user"
        exit 0
    fi
}

# Main execution
main() {
    local backup_file=""
    local verify_restore_flag=false

    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -f|--file)
                backup_file="$2"
                shift 2
                ;;
            -d|--database)
                POSTGRES_DATABASE="$2"
                shift 2
                ;;
            -h|--host)
                POSTGRES_HOST="$2"
                shift 2
                ;;
            -p|--port)
                POSTGRES_PORT="$2"
                shift 2
                ;;
            -u|--user)
                POSTGRES_USER="$2"
                shift 2
                ;;
            --drop)
                RESTORE_DROP_DATABASE="true"
                shift
                ;;
            --no-create)
                RESTORE_CREATE_DATABASE="false"
                shift
                ;;
            --verify)
                verify_restore_flag=true
                shift
                ;;
            --replace-live)
                REPLACE_LIVE=true
                shift
                ;;
            --pre-restore-backup)
                PRE_RESTORE_BACKUP="$2"
                shift 2
                ;;
            --preflight)
                PREFLIGHT_ONLY=true
                shift
                ;;
            --reuse-pre-restore-backup)
                REUSE_PRE_RESTORE_BACKUP=true
                shift
                ;;
            --list)
                list_backups
                ;;
            --help)
                usage
                ;;
            *)
                log_error "Unknown option: $1"
                usage
                ;;
        esac
    done

    # Check if backup file is provided
    if [[ -z "${backup_file}" ]]; then
        log_error "Backup file not specified. Use --file option or --list to see available backups."
        usage
    fi
    if [[ "${REPLACE_LIVE}" == "true" && -z "${PRE_RESTORE_BACKUP}" ]]; then
        log_error "--replace-live requires --pre-restore-backup FILE"
        exit 1
    fi
    if [[ -n "${PRE_RESTORE_BACKUP}" && "${PRE_RESTORE_BACKUP}" -ef "${backup_file}" ]]; then
        log_error "--pre-restore-backup must not be the backup being restored (--file) - nothing was changed"
        exit 1
    fi
    # The name is interpolated into DROP/CREATE DATABASE and the existence and session queries.
    if [[ ! "${POSTGRES_DATABASE}" =~ ^[a-z_][a-z0-9_]*$ ]]; then
        log_error "Unsupported database name: ${POSTGRES_DATABASE}"
        exit 1
    fi

    log_info "===== HappyCMDB PostgreSQL Restore ====="

    # Verify backup file
    verify_backup_file "${backup_file}"

    # Check database connection
    check_connection

    local existing database_exists=false
    if ! existing=$(pg_query postgres "SELECT 1 FROM pg_database WHERE datname = '${POSTGRES_DATABASE}'"); then
        log_error "Cannot check whether '${POSTGRES_DATABASE}' exists - nothing was changed"
        exit 1
    fi
    [[ -n "${existing}" ]] && database_exists=true

    if [[ "${REPLACE_LIVE}" == "true" ]]; then
        replace_live "${backup_file}" "${database_exists}"
        return
    fi
    if [[ "${PREFLIGHT_ONLY}" == "true" ]]; then
        if [[ "${database_exists}" == "true" ]]; then
            log_error "Database '${POSTGRES_DATABASE}' exists: replacing it needs --replace-live --pre-restore-backup FILE (rollback.sh: --replace-live-postgres) - nothing was changed"
            exit 1
        fi
        log_success "Preflight passed: '${POSTGRES_DATABASE}' does not exist and will be created - nothing was changed"
        echo "${PREFLIGHT_MARKER}"
        exit 0
    fi

    # Request confirmation (if interactive)
    if [[ -t 0 ]]; then
        confirm_restore "${backup_file}"
    fi

    # Drop database if requested
    if [[ "${RESTORE_DROP_DATABASE}" == "true" ]]; then
        drop_database
    fi

    # Create database if requested
    if [[ "${RESTORE_CREATE_DATABASE}" == "true" ]]; then
        create_database
    fi

    # A failed load is rolled back; it changed something only if this run dropped or created the database.
    if ! perform_restore "${backup_file}"; then
        if [[ "${RESTORE_DROP_DATABASE}" == "true" || "${RESTORE_CREATE_DATABASE}" == "true" ]]; then
            restore_failed 3 "the load did not complete: '${POSTGRES_DATABASE}' is empty or incomplete"
        fi
        log_error "Restore failed: the load was rolled back"
        exit 1
    fi

    # Verify restore if requested
    if ${verify_restore_flag}; then
        verify_restore "${backup_file}" || restore_failed 4 "'${POSTGRES_DATABASE}' is loaded but does NOT match the backup"
    fi

    log_success "Restore completed successfully - grants NOT restored"
    print_grant_step
}

# Run main function
main "$@"
