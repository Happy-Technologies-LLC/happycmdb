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
    --verify                Verify restore by checking table counts
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

# Perform restore
perform_restore() {
    local backup_file="$1"

    log_info "Starting restore process..."
    log_info "Backup file: ${backup_file}"
    log_info "Target database: ${POSTGRES_DATABASE}"
    log_info "Host: ${POSTGRES_HOST}:${POSTGRES_PORT}"

    export PGPASSWORD="${POSTGRES_PASSWORD}"

    local start_time=$(date +%s)

    # Decompress and restore in one step
    if gunzip -c "${backup_file}" | \
        psql -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -U "${POSTGRES_USER}" -d "${POSTGRES_DATABASE}" \
        2>&1 | grep -v "^$" | grep -v "SET" | grep -v "COMMENT"; then

        local end_time=$(date +%s)
        local duration=$((end_time - start_time))

        log_success "Restore completed in ${duration} seconds"
    else
        log_error "Restore failed"
        exit 1
    fi

    unset PGPASSWORD
}

# Verify restore by checking table counts
verify_restore() {
    log_info "Verifying restore..."

    export PGPASSWORD="${POSTGRES_PASSWORD}"

    # Get table count
    local table_count=$(psql -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -U "${POSTGRES_USER}" -d "${POSTGRES_DATABASE}" -t -c \
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")

    log_info "Tables restored: ${table_count}"

    if [[ ${table_count} -gt 0 ]]; then
        log_success "Restore verification successful"

        # Show table row counts
        log_info "Table row counts:"
        psql -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -U "${POSTGRES_USER}" -d "${POSTGRES_DATABASE}" -c \
            "SELECT schemaname, tablename, n_live_tup as rows FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 10;"
    else
        log_warning "No tables found in restored database"
    fi

    unset PGPASSWORD
}

# Request confirmation
confirm_restore() {
    local backup_file="$1"

    echo ""
    log_warning "=== RESTORE CONFIRMATION ==="
    log_warning "Backup file: ${backup_file}"
    log_warning "Target database: ${POSTGRES_DATABASE}"
    log_warning "Host: ${POSTGRES_HOST}:${POSTGRES_PORT}"

    if [[ "${RESTORE_DROP_DATABASE}" == "true" ]]; then
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

    log_info "===== HappyCMDB PostgreSQL Restore ====="

    # Verify backup file
    verify_backup_file "${backup_file}"

    # Check database connection
    check_connection

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

    # Perform restore
    perform_restore "${backup_file}"

    # Verify restore if requested
    if ${verify_restore_flag}; then
        verify_restore
    fi

    log_success "Restore completed successfully!"
}

# Run main function
main "$@"
