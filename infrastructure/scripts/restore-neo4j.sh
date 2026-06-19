#!/bin/bash
#
# Neo4j Restore Script for HappyCMDB
# Supports restore from compressed database dumps with verification
#

set -euo pipefail

# Configuration from environment variables or defaults
BACKUP_DIR="${BACKUP_DIR:-/var/backups/happycmdb/neo4j}"
NEO4J_CONTAINER="${NEO4J_CONTAINER:-cmdb-neo4j}"
NEO4J_DATABASE="${NEO4J_DATABASE:-cmdb}"
NEO4J_USERNAME="${NEO4J_USERNAME:-neo4j}"
NEO4J_PASSWORD="${NEO4J_PASSWORD:-}"
NEO4J_URI="${NEO4J_URI:-bolt://localhost:7687}"

# Restore options
RESTORE_FORCE="${RESTORE_FORCE:-false}"

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

Restore Neo4j database from backup.

OPTIONS:
    -f, --file FILE         Backup file to restore (required)
    -d, --database NAME     Target database name (default: ${NEO4J_DATABASE})
    -c, --container NAME    Neo4j container name (default: ${NEO4J_CONTAINER})
    --force                 Force restore (overwrite existing database)
    --verify                Verify restore by checking node/relationship counts
    --help                  Display this help message

EXAMPLES:
    # List available backups
    $0 --list

    # Restore latest daily backup
    $0 --file \$(ls -t ${BACKUP_DIR}/daily/*.dump.gz | head -1)

    # Restore specific backup with force
    $0 --file /path/to/backup.dump.gz --force --verify

    # Restore to different database
    $0 --file backup.dump.gz --database cmdb_test
EOF
    exit 0
}

# List available backups
list_backups() {
    log_info "Available backups:"
    echo ""
    echo "=== Daily Backups ==="
    ls -lh "${BACKUP_DIR}/daily"/*.dump.gz 2>/dev/null | awk '{print $9, "("$5")", $6, $7, $8}' || echo "No daily backups found"
    echo ""
    echo "=== Weekly Backups ==="
    ls -lh "${BACKUP_DIR}/weekly"/*.dump.gz 2>/dev/null | awk '{print $9, "("$5")", $6, $7, $8}' || echo "No weekly backups found"
    echo ""
    echo "=== Monthly Backups ==="
    ls -lh "${BACKUP_DIR}/monthly"/*.dump.gz 2>/dev/null | awk '{print $9, "("$5")", $6, $7, $8}' || echo "No monthly backups found"
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

# Check if Docker container exists and is running
check_container() {
    if docker ps --filter "name=${NEO4J_CONTAINER}" --filter "status=running" | grep -q "${NEO4J_CONTAINER}"; then
        log_info "Neo4j container '${NEO4J_CONTAINER}' is running"
        return 0
    else
        log_error "Neo4j container '${NEO4J_CONTAINER}' is not running"
        exit 1
    fi
}

# Stop Neo4j database
stop_database() {
    log_info "Stopping Neo4j database '${NEO4J_DATABASE}'..."

    docker exec "${NEO4J_CONTAINER}" \
        cypher-shell -u "${NEO4J_USERNAME}" -p "${NEO4J_PASSWORD}" \
        "STOP DATABASE ${NEO4J_DATABASE};" 2>/dev/null || {
        log_warning "Database might already be stopped or does not exist"
    }

    # Wait for database to stop
    sleep 2

    log_success "Database stopped"
}

# Drop database if exists
drop_database() {
    log_warning "Dropping database '${NEO4J_DATABASE}' if it exists..."

    docker exec "${NEO4J_CONTAINER}" \
        cypher-shell -u "${NEO4J_USERNAME}" -p "${NEO4J_PASSWORD}" \
        "DROP DATABASE ${NEO4J_DATABASE} IF EXISTS;" 2>/dev/null || {
        log_warning "Database might not exist"
    }

    # Wait for drop to complete
    sleep 2

    log_success "Database dropped"
}

# Perform restore
perform_restore() {
    local backup_file="$1"

    log_info "Starting restore process..."
    log_info "Backup file: ${backup_file}"
    log_info "Target database: ${NEO4J_DATABASE}"
    log_info "Container: ${NEO4J_CONTAINER}"

    local start_time=$(date +%s)

    # Decompress backup to temporary location
    local temp_dir=$(mktemp -d)
    local temp_dump="${temp_dir}/$(basename ${backup_file} .gz)"

    log_info "Decompressing backup..."
    gunzip -c "${backup_file}" > "${temp_dump}"

    # Copy dump file to container
    log_info "Copying dump file to container..."
    local container_dump="/tmp/${NEO4J_DATABASE}.dump"

    if docker cp "${temp_dump}" "${NEO4J_CONTAINER}:${container_dump}"; then
        log_success "Dump file copied to container"
    else
        log_error "Failed to copy dump file to container"
        rm -rf "${temp_dir}"
        exit 1
    fi

    # Clean up temporary file
    rm -rf "${temp_dir}"

    # Restore database using neo4j-admin load
    log_info "Restoring database from dump..."

    local load_opts=""
    if [[ "${RESTORE_FORCE}" == "true" ]]; then
        load_opts="--overwrite-destination=true"
    fi

    if docker exec "${NEO4J_CONTAINER}" \
        neo4j-admin database load \
        --from-path=/tmp \
        ${load_opts} \
        "${NEO4J_DATABASE}" 2>&1; then

        local end_time=$(date +%s)
        local duration=$((end_time - start_time))

        log_success "Restore completed in ${duration} seconds"
    else
        log_error "Restore failed"
        exit 1
    fi

    # Clean up dump file in container
    docker exec "${NEO4J_CONTAINER}" rm -f "${container_dump}" 2>/dev/null || true
}

# Start database
start_database() {
    log_info "Starting Neo4j database '${NEO4J_DATABASE}'..."

    docker exec "${NEO4J_CONTAINER}" \
        cypher-shell -u "${NEO4J_USERNAME}" -p "${NEO4J_PASSWORD}" \
        "CREATE DATABASE ${NEO4J_DATABASE} IF NOT EXISTS;" || {
        log_error "Failed to create/start database"
        exit 1
    }

    # Wait for database to start
    log_info "Waiting for database to start..."
    sleep 5

    log_success "Database started"
}

# Verify restore by checking node/relationship counts
verify_restore() {
    log_info "Verifying restore..."

    # Wait for database to be fully online
    sleep 3

    # Get node count
    local node_count=$(docker exec "${NEO4J_CONTAINER}" \
        cypher-shell -u "${NEO4J_USERNAME}" -p "${NEO4J_PASSWORD}" -d "${NEO4J_DATABASE}" \
        "MATCH (n) RETURN count(n) AS count;" 2>/dev/null | grep -v "count" | grep -v "^$" | tr -d ' ' || echo "0")

    # Get relationship count
    local rel_count=$(docker exec "${NEO4J_CONTAINER}" \
        cypher-shell -u "${NEO4J_USERNAME}" -p "${NEO4J_PASSWORD}" -d "${NEO4J_DATABASE}" \
        "MATCH ()-[r]->() RETURN count(r) AS count;" 2>/dev/null | grep -v "count" | grep -v "^$" | tr -d ' ' || echo "0")

    log_info "Nodes restored: ${node_count}"
    log_info "Relationships restored: ${rel_count}"

    if [[ ${node_count} -gt 0 ]]; then
        log_success "Restore verification successful"

        # Show label counts
        log_info "Node label counts:"
        docker exec "${NEO4J_CONTAINER}" \
            cypher-shell -u "${NEO4J_USERNAME}" -p "${NEO4J_PASSWORD}" -d "${NEO4J_DATABASE}" \
            "CALL db.labels() YIELD label CALL apoc.cypher.run('MATCH (n:\`' + label + '\`) RETURN count(n) as count', {}) YIELD value RETURN label, value.count ORDER BY value.count DESC LIMIT 10;" 2>/dev/null || true
    else
        log_warning "No nodes found in restored database"
    fi
}

# Request confirmation
confirm_restore() {
    local backup_file="$1"

    echo ""
    log_warning "=== RESTORE CONFIRMATION ==="
    log_warning "Backup file: ${backup_file}"
    log_warning "Target database: ${NEO4J_DATABASE}"
    log_warning "Container: ${NEO4J_CONTAINER}"

    if [[ "${RESTORE_FORCE}" == "true" ]]; then
        log_warning "WARNING: Existing database will be OVERWRITTEN!"
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
                NEO4J_DATABASE="$2"
                shift 2
                ;;
            -c|--container)
                NEO4J_CONTAINER="$2"
                shift 2
                ;;
            --force)
                RESTORE_FORCE="true"
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

    log_info "===== HappyCMDB Neo4j Restore ====="

    # Verify backup file
    verify_backup_file "${backup_file}"

    # Check if container is running
    check_container

    # Request confirmation (if interactive)
    if [[ -t 0 ]]; then
        confirm_restore "${backup_file}"
    fi

    # Stop database
    stop_database

    # Drop database if force restore
    if [[ "${RESTORE_FORCE}" == "true" ]]; then
        drop_database
    fi

    # Perform restore
    perform_restore "${backup_file}"

    # Start database
    start_database

    # Verify restore if requested
    if ${verify_restore_flag}; then
        verify_restore
    fi

    log_success "Restore completed successfully!"
}

# Run main function
main "$@"
