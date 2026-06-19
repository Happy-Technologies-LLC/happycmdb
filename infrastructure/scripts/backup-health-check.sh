#!/bin/bash
#
# Backup Health Check and Monitoring Script for HappyCMDB
# Checks backup status, disk usage, and sends alerts
#

set -euo pipefail

# Configuration
BACKUP_DIR="${BACKUP_DIR:-/var/backups/happycmdb}"
POSTGRES_BACKUP_DIR="${BACKUP_DIR}/postgres"
NEO4J_BACKUP_DIR="${BACKUP_DIR}/neo4j"
LOG_DIR="${BACKUP_LOG_DIR:-/var/log/happycmdb/backups}"

# Alert thresholds
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-25}"  # Alert if latest backup is older than 25 hours
BACKUP_MIN_COUNT="${BACKUP_MIN_COUNT:-3}"  # Alert if fewer than 3 daily backups
DISK_USAGE_THRESHOLD="${DISK_USAGE_THRESHOLD:-85}"  # Alert if disk usage exceeds 85%

# Notification configuration
BACKUP_NOTIFICATION_ENABLED="${BACKUP_NOTIFICATION_ENABLED:-false}"
BACKUP_NOTIFICATION_WEBHOOK="${BACKUP_NOTIFICATION_WEBHOOK:-}"

# Exit codes
EXIT_OK=0
EXIT_WARNING=1
EXIT_CRITICAL=2
EXIT_UNKNOWN=3

# Logging functions
log_info() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] INFO: $*"
}

log_error() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
}

log_warning() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] WARNING: $*"
}

log_success() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] SUCCESS: $*"
}

# Send notification
send_notification() {
    local status="$1"
    local message="$2"

    if [[ "${BACKUP_NOTIFICATION_ENABLED}" == "true" ]] && [[ -n "${BACKUP_NOTIFICATION_WEBHOOK}" ]]; then
        curl -X POST "${BACKUP_NOTIFICATION_WEBHOOK}" \
            -H "Content-Type: application/json" \
            -d "{\"service\":\"HappyCMDB Backup Health Check\",\"status\":\"${status}\",\"message\":\"${message}\",\"timestamp\":\"$(date -Iseconds)\"}" \
            2>/dev/null || log_error "Failed to send notification"
    fi
}

# Check if backup directory exists
check_backup_dirs() {
    local status="${EXIT_OK}"

    log_info "Checking backup directories..."

    if [[ ! -d "${POSTGRES_BACKUP_DIR}" ]]; then
        log_error "PostgreSQL backup directory does not exist: ${POSTGRES_BACKUP_DIR}"
        status="${EXIT_CRITICAL}"
    fi

    if [[ ! -d "${NEO4J_BACKUP_DIR}" ]]; then
        log_error "Neo4j backup directory does not exist: ${NEO4J_BACKUP_DIR}"
        status="${EXIT_CRITICAL}"
    fi

    if [[ ${status} -eq ${EXIT_OK} ]]; then
        log_success "Backup directories exist"
    fi

    return ${status}
}

# Check latest backup age
check_backup_age() {
    local backup_dir="$1"
    local backup_type="$2"
    local max_age_seconds=$((BACKUP_MAX_AGE_HOURS * 3600))

    log_info "Checking ${backup_type} backup age..."

    # Find latest backup in daily directory
    local latest_backup=$(find "${backup_dir}/daily" -name "*.gz" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2)

    if [[ -z "${latest_backup}" ]]; then
        log_error "No ${backup_type} backups found"
        return "${EXIT_CRITICAL}"
    fi

    # Get backup age in seconds
    local backup_timestamp=$(stat -f %m "${latest_backup}" 2>/dev/null || stat -c %Y "${latest_backup}")
    local current_timestamp=$(date +%s)
    local backup_age=$((current_timestamp - backup_timestamp))

    # Convert to hours for display
    local backup_age_hours=$((backup_age / 3600))

    log_info "Latest ${backup_type} backup: ${latest_backup}"
    log_info "Backup age: ${backup_age_hours} hours"

    if [[ ${backup_age} -gt ${max_age_seconds} ]]; then
        log_warning "${backup_type} backup is older than ${BACKUP_MAX_AGE_HOURS} hours"
        return "${EXIT_WARNING}"
    else
        log_success "${backup_type} backup age is acceptable"
        return "${EXIT_OK}"
    fi
}

# Check backup count
check_backup_count() {
    local backup_dir="$1"
    local backup_type="$2"

    log_info "Checking ${backup_type} backup count..."

    local daily_count=$(find "${backup_dir}/daily" -name "*.gz" -type f 2>/dev/null | wc -l)
    local weekly_count=$(find "${backup_dir}/weekly" -name "*.gz" -type f 2>/dev/null | wc -l)
    local monthly_count=$(find "${backup_dir}/monthly" -name "*.gz" -type f 2>/dev/null | wc -l)

    log_info "${backup_type} backups: ${daily_count} daily, ${weekly_count} weekly, ${monthly_count} monthly"

    if [[ ${daily_count} -lt ${BACKUP_MIN_COUNT} ]]; then
        log_warning "Insufficient ${backup_type} daily backups (found: ${daily_count}, minimum: ${BACKUP_MIN_COUNT})"
        return "${EXIT_WARNING}"
    else
        log_success "${backup_type} backup count is acceptable"
        return "${EXIT_OK}"
    fi
}

# Check backup integrity (test random sample)
check_backup_integrity() {
    local backup_dir="$1"
    local backup_type="$2"

    log_info "Checking ${backup_type} backup integrity (sampling)..."

    # Test 3 most recent backups
    local backups=$(find "${backup_dir}/daily" -name "*.gz" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -3 | cut -d' ' -f2)

    if [[ -z "${backups}" ]]; then
        log_error "No ${backup_type} backups to verify"
        return "${EXIT_CRITICAL}"
    fi

    local failed_count=0
    local total_count=0

    while IFS= read -r backup_file; do
        ((total_count++))

        if ! gzip -t "${backup_file}" 2>/dev/null; then
            log_error "Corrupted backup: ${backup_file}"
            ((failed_count++))
        fi
    done <<< "${backups}"

    if [[ ${failed_count} -gt 0 ]]; then
        log_error "${failed_count}/${total_count} ${backup_type} backups are corrupted"
        return "${EXIT_CRITICAL}"
    else
        log_success "All sampled ${backup_type} backups are valid (${total_count} tested)"
        return "${EXIT_OK}"
    fi
}

# Check disk usage
check_disk_usage() {
    log_info "Checking disk usage..."

    local disk_usage=$(df -h "${BACKUP_DIR}" | awk 'NR==2 {print $5}' | sed 's/%//')

    log_info "Backup disk usage: ${disk_usage}%"

    if [[ ${disk_usage} -gt ${DISK_USAGE_THRESHOLD} ]]; then
        log_warning "Disk usage exceeds threshold (${disk_usage}% > ${DISK_USAGE_THRESHOLD}%)"
        return "${EXIT_WARNING}"
    else
        log_success "Disk usage is acceptable"
        return "${EXIT_OK}"
    fi
}

# Check backup sizes
check_backup_sizes() {
    log_info "Checking backup sizes..."

    # Get total size of all backups
    local postgres_size=$(du -sh "${POSTGRES_BACKUP_DIR}" 2>/dev/null | cut -f1)
    local neo4j_size=$(du -sh "${NEO4J_BACKUP_DIR}" 2>/dev/null | cut -f1)

    log_info "PostgreSQL backups total size: ${postgres_size}"
    log_info "Neo4j backups total size: ${neo4j_size}"

    # Get latest backup sizes
    local latest_postgres=$(find "${POSTGRES_BACKUP_DIR}/daily" -name "*.gz" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2)
    local latest_neo4j=$(find "${NEO4J_BACKUP_DIR}/daily" -name "*.gz" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2)

    if [[ -n "${latest_postgres}" ]]; then
        local postgres_latest_size=$(du -h "${latest_postgres}" 2>/dev/null | cut -f1)
        log_info "Latest PostgreSQL backup size: ${postgres_latest_size}"
    fi

    if [[ -n "${latest_neo4j}" ]]; then
        local neo4j_latest_size=$(du -h "${latest_neo4j}" 2>/dev/null | cut -f1)
        log_info "Latest Neo4j backup size: ${neo4j_latest_size}"
    fi

    return "${EXIT_OK}"
}

# Check last backup log
check_last_backup_log() {
    log_info "Checking last backup log..."

    if [[ ! -d "${LOG_DIR}" ]]; then
        log_warning "Log directory does not exist: ${LOG_DIR}"
        return "${EXIT_WARNING}"
    fi

    local latest_log=$(ls -t "${LOG_DIR}"/backup_*.log 2>/dev/null | head -1)

    if [[ -z "${latest_log}" ]]; then
        log_warning "No backup logs found"
        return "${EXIT_WARNING}"
    fi

    log_info "Latest backup log: ${latest_log}"

    # Check for errors in log
    if grep -qi "ERROR" "${latest_log}"; then
        log_error "Errors found in latest backup log"
        return "${EXIT_CRITICAL}"
    elif grep -qi "WARNING" "${latest_log}"; then
        log_warning "Warnings found in latest backup log"
        return "${EXIT_WARNING}"
    else
        log_success "No errors in latest backup log"
        return "${EXIT_OK}"
    fi
}

# Generate health report
generate_health_report() {
    local overall_status="$1"

    echo ""
    log_info "===== Backup Health Report ====="
    log_info "Timestamp: $(date -Iseconds)"
    log_info "Overall Status: ${overall_status}"
    log_info ""

    # Summary statistics
    if [[ -d "${POSTGRES_BACKUP_DIR}" ]]; then
        local postgres_daily=$(find "${POSTGRES_BACKUP_DIR}/daily" -name "*.gz" -type f 2>/dev/null | wc -l)
        local postgres_size=$(du -sh "${POSTGRES_BACKUP_DIR}" 2>/dev/null | cut -f1)
        log_info "PostgreSQL: ${postgres_daily} daily backups, ${postgres_size} total"
    fi

    if [[ -d "${NEO4J_BACKUP_DIR}" ]]; then
        local neo4j_daily=$(find "${NEO4J_BACKUP_DIR}/daily" -name "*.gz" -type f 2>/dev/null | wc -l)
        local neo4j_size=$(du -sh "${NEO4J_BACKUP_DIR}" 2>/dev/null | cut -f1)
        log_info "Neo4j: ${neo4j_daily} daily backups, ${neo4j_size} total"
    fi

    local disk_usage=$(df -h "${BACKUP_DIR}" | awk 'NR==2 {print $5}')
    log_info "Disk usage: ${disk_usage}"

    log_info "================================"
}

# Main execution
main() {
    log_info "===== HappyCMDB Backup Health Check ====="

    local overall_status="${EXIT_OK}"
    local status_text="HEALTHY"
    local issues=()

    # Check backup directories
    if ! check_backup_dirs; then
        overall_status="${EXIT_CRITICAL}"
        status_text="CRITICAL"
        issues+=("Backup directories missing")
    fi

    # Check PostgreSQL backups
    if ! check_backup_age "${POSTGRES_BACKUP_DIR}" "PostgreSQL"; then
        overall_status="${EXIT_WARNING}"
        [[ "${status_text}" != "CRITICAL" ]] && status_text="WARNING"
        issues+=("PostgreSQL backup age")
    fi

    if ! check_backup_count "${POSTGRES_BACKUP_DIR}" "PostgreSQL"; then
        overall_status="${EXIT_WARNING}"
        [[ "${status_text}" != "CRITICAL" ]] && status_text="WARNING"
        issues+=("PostgreSQL backup count")
    fi

    if ! check_backup_integrity "${POSTGRES_BACKUP_DIR}" "PostgreSQL"; then
        overall_status="${EXIT_CRITICAL}"
        status_text="CRITICAL"
        issues+=("PostgreSQL backup integrity")
    fi

    # Check Neo4j backups
    if ! check_backup_age "${NEO4J_BACKUP_DIR}" "Neo4j"; then
        overall_status="${EXIT_WARNING}"
        [[ "${status_text}" != "CRITICAL" ]] && status_text="WARNING"
        issues+=("Neo4j backup age")
    fi

    if ! check_backup_count "${NEO4J_BACKUP_DIR}" "Neo4j"; then
        overall_status="${EXIT_WARNING}"
        [[ "${status_text}" != "CRITICAL" ]] && status_text="WARNING"
        issues+=("Neo4j backup count")
    fi

    if ! check_backup_integrity "${NEO4J_BACKUP_DIR}" "Neo4j"; then
        overall_status="${EXIT_CRITICAL}"
        status_text="CRITICAL"
        issues+=("Neo4j backup integrity")
    fi

    # Check disk usage
    if ! check_disk_usage; then
        overall_status="${EXIT_WARNING}"
        [[ "${status_text}" != "CRITICAL" ]] && status_text="WARNING"
        issues+=("Disk usage high")
    fi

    # Check backup sizes
    check_backup_sizes

    # Check last backup log
    if ! check_last_backup_log; then
        [[ "${status_text}" == "HEALTHY" ]] && status_text="WARNING"
        issues+=("Backup log issues")
    fi

    # Generate report
    generate_health_report "${status_text}"

    # Send notification if issues found
    if [[ ${#issues[@]} -gt 0 ]]; then
        local issue_list=$(IFS=', '; echo "${issues[*]}")
        send_notification "${status_text}" "Backup health check found issues: ${issue_list}"
    else
        send_notification "SUCCESS" "All backup health checks passed"
    fi

    # Exit with appropriate status
    if [[ "${status_text}" == "HEALTHY" ]]; then
        log_success "All health checks passed!"
        exit "${EXIT_OK}"
    elif [[ "${status_text}" == "WARNING" ]]; then
        log_warning "Health check completed with warnings"
        exit "${EXIT_WARNING}"
    else
        log_error "Health check completed with critical issues"
        exit "${EXIT_CRITICAL}"
    fi
}

# Run main function
main "$@"
