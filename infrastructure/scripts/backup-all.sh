#!/bin/bash
#
# Unified Backup Orchestration Script for HappyCMDB
# Backs up both PostgreSQL and Neo4j databases
#

set -euo pipefail

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Configuration
BACKUP_LOG_DIR="${BACKUP_LOG_DIR:-/var/log/happycmdb/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="${BACKUP_LOG_DIR}/backup_${TIMESTAMP}.log"

# Notification configuration
BACKUP_NOTIFICATION_ENABLED="${BACKUP_NOTIFICATION_ENABLED:-false}"
BACKUP_NOTIFICATION_WEBHOOK="${BACKUP_NOTIFICATION_WEBHOOK:-}"

# Logging functions
log_info() {
    local message="[$(date +'%Y-%m-%d %H:%M:%S')] INFO: $*"
    echo "${message}"
    echo "${message}" >> "${LOG_FILE}" 2>/dev/null || true
}

log_error() {
    local message="[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*"
    echo "${message}" >&2
    echo "${message}" >> "${LOG_FILE}" 2>/dev/null || true
}

log_success() {
    local message="[$(date +'%Y-%m-%d %H:%M:%S')] SUCCESS: $*"
    echo "${message}"
    echo "${message}" >> "${LOG_FILE}" 2>/dev/null || true
}

# Send notification
send_notification() {
    local status="$1"
    local message="$2"

    if [[ "${BACKUP_NOTIFICATION_ENABLED}" == "true" ]] && [[ -n "${BACKUP_NOTIFICATION_WEBHOOK}" ]]; then
        curl -X POST "${BACKUP_NOTIFICATION_WEBHOOK}" \
            -H "Content-Type: application/json" \
            -d "{\"service\":\"HappyCMDB Backup System\",\"status\":\"${status}\",\"message\":\"${message}\",\"timestamp\":\"$(date -Iseconds)\"}" \
            2>/dev/null || log_error "Failed to send notification"
    fi
}

# Create log directory
create_log_dir() {
    mkdir -p "${BACKUP_LOG_DIR}"
}

# Run backup script with error handling
run_backup() {
    local script_name="$1"
    local script_path="${SCRIPT_DIR}/${script_name}"

    log_info "Running ${script_name}..."

    if [[ ! -f "${script_path}" ]]; then
        log_error "Script not found: ${script_path}"
        return 1
    fi

    if [[ ! -x "${script_path}" ]]; then
        log_error "Script not executable: ${script_path}"
        return 1
    fi

    # Run backup script and capture output
    local start_time=$(date +%s)
    if "${script_path}" >> "${LOG_FILE}" 2>&1; then
        local end_time=$(date +%s)
        local duration=$((end_time - start_time))
        log_success "${script_name} completed in ${duration} seconds"
        return 0
    else
        local end_time=$(date +%s)
        local duration=$((end_time - start_time))
        log_error "${script_name} failed after ${duration} seconds"
        return 1
    fi
}

# Generate summary report
generate_summary() {
    local postgres_status="$1"
    local neo4j_status="$2"

    log_info "===== Backup Summary ====="
    log_info "Timestamp: ${TIMESTAMP}"
    log_info "PostgreSQL: ${postgres_status}"
    log_info "Neo4j: ${neo4j_status}"

    # Count total backups
    if [[ -n "${BACKUP_DIR:-}" ]]; then
        local postgres_count=$(find "${BACKUP_DIR}/postgres" -name "*.sql.gz" -type f 2>/dev/null | wc -l)
        local neo4j_count=$(find "${BACKUP_DIR}/neo4j" -name "*.dump.gz" -type f 2>/dev/null | wc -l)
        log_info "Total backups: ${postgres_count} PostgreSQL, ${neo4j_count} Neo4j"
    fi

    log_info "Log file: ${LOG_FILE}"
    log_info "========================="
}

# Clean old log files (keep last 30 days)
clean_old_logs() {
    log_info "Cleaning old log files (keep last 30 days)..."
    find "${BACKUP_LOG_DIR}" -name "backup_*.log" -type f -mtime +30 -delete 2>/dev/null || true
}

# Main execution
main() {
    log_info "===== HappyCMDB Database Backup ====="
    log_info "Starting unified backup for PostgreSQL and Neo4j"

    # Create log directory
    create_log_dir

    local postgres_status="NOT_RUN"
    local neo4j_status="NOT_RUN"
    local overall_success=true

    # Run PostgreSQL backup
    if run_backup "backup-postgres.sh"; then
        postgres_status="SUCCESS"
    else
        postgres_status="FAILED"
        overall_success=false
    fi

    # Run Neo4j backup
    if run_backup "backup-neo4j.sh"; then
        neo4j_status="SUCCESS"
    else
        neo4j_status="FAILED"
        overall_success=false
    fi

    # Generate summary
    generate_summary "${postgres_status}" "${neo4j_status}"

    # Clean old logs
    clean_old_logs

    # Send notification
    if ${overall_success}; then
        send_notification "SUCCESS" "All database backups completed successfully"
        log_success "All backups completed successfully!"
        exit 0
    else
        send_notification "FAILED" "One or more database backups failed (PostgreSQL: ${postgres_status}, Neo4j: ${neo4j_status})"
        log_error "One or more backups failed!"
        exit 1
    fi
}

# Run main function
main "$@"
