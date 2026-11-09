#!/bin/bash
#
# Neo4j Backup Script for HappyCMDB
# Supports database dumps, compression, retention policies, and cloud upload
#
# HAP-1748: Neo4j Community Edition dumps only a stopped DBMS, so every backup stops the Neo4j container for the dump
# and starts it again (neo4j-offline.sh). Two modes:
#   --to FILE   The deploy backup (deploy-production.sh Step 2): writes FILE, a gzip of a neo4j-admin dump of the neo4j
#               database, verified, plus the node/relationship counts beside it. restore-neo4j.sh reads it.
#   (no args)   The daily layout under BACKUP_DIR with retention and upload. It stops Neo4j, so it runs only with
#               BACKUP_NEO4J_OFFLINE=true; otherwise it refuses before touching anything.
# Exit 0: backup written and verified. Non-zero: no backup; Neo4j was started again (if that failed, the output says
# STOPPED and prints the docker start command).
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Configuration from environment variables or defaults
BACKUP_DIR="${BACKUP_DIR:-/var/backups/happycmdb/neo4j}"
NEO4J_CONTAINER="${NEO4J_CONTAINER:-cmdb-neo4j}"
NEO4J_USERNAME="${NEO4J_USERNAME:-neo4j}"
NEO4J_PASSWORD="${NEO4J_PASSWORD:-}"
BACKUP_NEO4J_OFFLINE="${BACKUP_NEO4J_OFFLINE:-false}"

# Retention policy (days)
RETENTION_DAILY="${BACKUP_RETENTION_DAILY:-7}"
RETENTION_WEEKLY="${BACKUP_RETENTION_WEEKLY:-4}"
RETENTION_MONTHLY="${BACKUP_RETENTION_MONTHLY:-12}"

# Cloud storage configuration
BACKUP_UPLOAD_ENABLED="${BACKUP_UPLOAD_ENABLED:-false}"
BACKUP_STORAGE_TYPE="${BACKUP_STORAGE_TYPE:-s3}"  # s3 or azure
S3_BUCKET="${BACKUP_S3_BUCKET:-}"
S3_PREFIX="${BACKUP_S3_PREFIX:-happycmdb/neo4j}"
AZURE_CONTAINER="${BACKUP_AZURE_CONTAINER:-}"
AZURE_PREFIX="${BACKUP_AZURE_PREFIX:-happycmdb/neo4j}"

# Notification configuration
BACKUP_NOTIFICATION_ENABLED="${BACKUP_NOTIFICATION_ENABLED:-false}"
BACKUP_NOTIFICATION_WEBHOOK="${BACKUP_NOTIFICATION_WEBHOOK:-}"

# Timestamp for backup file
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DAY_OF_WEEK=$(date +%u)  # 1-7 (Monday-Sunday)
DAY_OF_MONTH=$(date +%d)

# shellcheck source=neo4j-offline.sh
source "${SCRIPT_DIR}/neo4j-offline.sh"

# Daily backup filename
BACKUP_FILE_GZ="neo4j_${NEO4J_DUMP_DATABASE}_${TIMESTAMP}.dump.gz"

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

# Send notification (webhook)
send_notification() {
    local status="$1"
    local message="$2"

    if [[ "${BACKUP_NOTIFICATION_ENABLED}" == "true" ]] && [[ -n "${BACKUP_NOTIFICATION_WEBHOOK}" ]]; then
        curl -X POST "${BACKUP_NOTIFICATION_WEBHOOK}" \
            -H "Content-Type: application/json" \
            -d "{\"service\":\"HappyCMDB Neo4j Backup\",\"status\":\"${status}\",\"message\":\"${message}\",\"timestamp\":\"$(date -Iseconds)\"}" \
            2>/dev/null || log_error "Failed to send notification"
    fi
}

# Create backup directory structure
create_backup_dirs() {
    log_info "Creating backup directory structure..."
    mkdir -p "${BACKUP_DIR}"/{daily,weekly,monthly}
}

# Check if Docker container exists and is running
check_container() {
    if neo4j_container_running; then
        log_info "Neo4j container '${NEO4J_CONTAINER}' is running"
        return 0
    fi
    log_error "Neo4j container '${NEO4J_CONTAINER}' is not running"
    return 1
}

# Stops Neo4j, dumps it into FILE, starts it again and verifies FILE. The counts are recorded beside FILE only when
# they are the same before the stop and after the start, so they describe the dump.
offline_backup() {
    local file="$1" before after counts_file
    counts_file="$(neo4j_counts_file "${file}")"
    rm -f "${counts_file}"
    log_info "Starting Neo4j backup of the '${NEO4J_DUMP_DATABASE}' database (container: ${NEO4J_CONTAINER}) to ${file}"
    before="$(neo4j_counts)" || before=""
    neo4j_stop || return 1
    neo4j_dump_to "${file}" || return 1
    neo4j_start || { rm -f "${file}"; return 1; }
    after="$(neo4j_counts)" || after=""
    if [[ -n "${before}" && "${before}" == "${after}" ]]; then
        echo "${before}" > "${counts_file}"
        log_info "Recorded counts (nodes relationships): ${before} in ${counts_file}"
    else
        log_warning "Counts unreadable or changed around the dump ('${before}' -> '${after}'): none recorded; a restore of this backup prints its counts without comparing them"
    fi
    if ! neo4j_verify_dump "${file}"; then
        rm -f "${file}" "${counts_file}"
        return 1
    fi
    log_info "Backup size (compressed): $(du -h "${file}" | cut -f1)"
}

# Upload to cloud storage
upload_to_cloud() {
    local backup_file="$1"

    if [[ "${BACKUP_UPLOAD_ENABLED}" != "true" ]]; then
        log_info "Cloud upload disabled, skipping..."
        return 0
    fi

    local filename=$(basename "${backup_file}")

    case "${BACKUP_STORAGE_TYPE}" in
        s3)
            log_info "Uploading to S3: s3://${S3_BUCKET}/${S3_PREFIX}/${filename}"
            if command -v aws &> /dev/null; then
                if aws s3 cp "${backup_file}" "s3://${S3_BUCKET}/${S3_PREFIX}/${filename}"; then
                    log_success "Uploaded to S3"
                else
                    log_error "S3 upload failed"
                    return 1
                fi
            else
                log_error "AWS CLI not installed"
                return 1
            fi
            ;;
        azure)
            log_info "Uploading to Azure Blob: ${AZURE_CONTAINER}/${AZURE_PREFIX}/${filename}"
            if command -v az &> /dev/null; then
                if az storage blob upload \
                    --container-name "${AZURE_CONTAINER}" \
                    --name "${AZURE_PREFIX}/${filename}" \
                    --file "${backup_file}" \
                    --overwrite; then
                    log_success "Uploaded to Azure Blob"
                else
                    log_error "Azure Blob upload failed"
                    return 1
                fi
            else
                log_error "Azure CLI not installed"
                return 1
            fi
            ;;
        *)
            log_error "Unknown storage type: ${BACKUP_STORAGE_TYPE}"
            return 1
            ;;
    esac
}

# Copy to weekly/monthly based on schedule
organize_backups() {
    local backup_file="$1"

    # Weekly backup (Sunday = 7)
    if [[ "${DAY_OF_WEEK}" == "7" ]]; then
        log_info "Creating weekly backup copy..."
        cp "${backup_file}" "${BACKUP_DIR}/weekly/"
    fi

    # Monthly backup (1st of month)
    if [[ "${DAY_OF_MONTH}" == "01" ]]; then
        log_info "Creating monthly backup copy..."
        cp "${backup_file}" "${BACKUP_DIR}/monthly/"
    fi
}

# Apply retention policy
apply_retention() {
    log_info "Applying retention policy..."

    # Daily backups (keep last N days)
    log_info "Cleaning daily backups (keep last ${RETENTION_DAILY} days)..."
    find "${BACKUP_DIR}/daily" \( -name "neo4j_*.dump.gz" -o -name "neo4j_*.counts" \) -type f -mtime +${RETENTION_DAILY} -delete

    # Weekly backups (keep last N weeks)
    if [[ -d "${BACKUP_DIR}/weekly" ]]; then
        log_info "Cleaning weekly backups (keep last ${RETENTION_WEEKLY} weeks)..."
        local weekly_days=$((RETENTION_WEEKLY * 7))
        find "${BACKUP_DIR}/weekly" -name "neo4j_*.dump.gz" -type f -mtime +${weekly_days} -delete
    fi

    # Monthly backups (keep last N months)
    if [[ -d "${BACKUP_DIR}/monthly" ]]; then
        log_info "Cleaning monthly backups (keep last ${RETENTION_MONTHLY} months)..."
        local monthly_days=$((RETENTION_MONTHLY * 30))
        find "${BACKUP_DIR}/monthly" -name "neo4j_*.dump.gz" -type f -mtime +${monthly_days} -delete
    fi

    log_success "Retention policy applied"
}

# Generate backup report
generate_report() {
    local backup_file="$1"
    local backup_size=$(du -h "${backup_file}" | cut -f1)

    log_info "=== Backup Report ==="
    log_info "Database: ${NEO4J_DUMP_DATABASE}"
    log_info "Timestamp: ${TIMESTAMP}"
    log_info "Backup file: ${backup_file}"
    log_info "Size: ${backup_size}"
    log_info "Retention: ${RETENTION_DAILY}d / ${RETENTION_WEEKLY}w / ${RETENTION_MONTHLY}m"

    # Count backups by type
    local daily_count=$(find "${BACKUP_DIR}/daily" -name "neo4j_*.dump.gz" -type f 2>/dev/null | wc -l)
    local weekly_count=$(find "${BACKUP_DIR}/weekly" -name "neo4j_*.dump.gz" -type f 2>/dev/null | wc -l)
    local monthly_count=$(find "${BACKUP_DIR}/monthly" -name "neo4j_*.dump.gz" -type f 2>/dev/null | wc -l)

    log_info "Current backups: ${daily_count} daily, ${weekly_count} weekly, ${monthly_count} monthly"
    log_info "====================="
}

# Main execution
main() {
    local target=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --to)
                target="${2:-}"
                [[ -n "${target}" ]] || { log_error "--to requires a FILE"; exit 1; }
                shift 2
                ;;
            *)
                log_error "Unknown argument: $1 (usage: $0 [--to FILE])"
                exit 1
                ;;
        esac
    done

    log_info "===== HappyCMDB Neo4j Backup ====="

    if [[ -z "${target}" && "${BACKUP_NEO4J_OFFLINE}" != "true" ]]; then
        log_error "Refusing the daily Neo4j backup: it stops the Neo4j container for the dump (Community Edition dumps only" \
            "a stopped DBMS). Set BACKUP_NEO4J_OFFLINE=true to accept that outage. Nothing changed."
        exit 1
    fi
    if [[ -n "${target}" && ( -e "${target}" || ! -d "$(dirname "${target}")" ) ]]; then
        log_error "--to ${target}: the file must not exist and its directory must. Nothing changed."
        exit 1
    fi

    # HAP-1647: cypher-shell reads it from the environment (docker exec -e NEO4J_PASSWORD), never argv.
    : "${NEO4J_PASSWORD:?must be set}"
    export NEO4J_PASSWORD

    check_container || { send_notification "FAILED" "Neo4j container not running"; exit 1; }
    neo4j_resolve_image || exit 1

    if [[ -n "${target}" ]]; then
        offline_backup "${target}" || exit 1
        log_success "Neo4j backup written and verified: ${target}"
        exit 0
    fi

    create_backup_dirs
    local backup_file="${BACKUP_DIR}/daily/${BACKUP_FILE_GZ}"
    if ! offline_backup "${backup_file}"; then
        send_notification "FAILED" "Neo4j backup failed (${NEO4J_DUMP_DATABASE})"
        exit 1
    fi

    # Upload to cloud storage
    if ! upload_to_cloud "${backup_file}"; then
        log_error "Cloud upload failed, but backup is stored locally"
        send_notification "WARNING" "Neo4j backup created but cloud upload failed"
    fi

    # Organize backups (weekly/monthly copies)
    organize_backups "${backup_file}"

    # Apply retention policy
    apply_retention

    # Generate report
    generate_report "${backup_file}"

    # Send success notification
    send_notification "SUCCESS" "Neo4j backup completed successfully (${NEO4J_DUMP_DATABASE})"

    log_success "Backup completed successfully!"
}

# Run main function
main "$@"
