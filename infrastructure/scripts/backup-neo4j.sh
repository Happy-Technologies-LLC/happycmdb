#!/bin/bash
#
# Neo4j Backup Script for HappyCMDB
# Supports database dumps, compression, retention policies, and cloud upload
#

set -euo pipefail

# Configuration from environment variables or defaults
BACKUP_DIR="${BACKUP_DIR:-/var/backups/happycmdb/neo4j}"
NEO4J_CONTAINER="${NEO4J_CONTAINER:-cmdb-neo4j}"
NEO4J_DATABASE="${NEO4J_DATABASE:-cmdb}"
NEO4J_USERNAME="${NEO4J_USERNAME:-neo4j}"
NEO4J_PASSWORD="${NEO4J_PASSWORD:-}"
NEO4J_URI="${NEO4J_URI:-bolt://localhost:7687}"

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

# Backup filename
BACKUP_FILE="neo4j_${NEO4J_DATABASE}_${TIMESTAMP}.dump"
BACKUP_FILE_GZ="${BACKUP_FILE}.gz"

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
    if docker ps --filter "name=${NEO4J_CONTAINER}" --filter "status=running" | grep -q "${NEO4J_CONTAINER}"; then
        log_info "Neo4j container '${NEO4J_CONTAINER}' is running"
        return 0
    else
        log_error "Neo4j container '${NEO4J_CONTAINER}' is not running"
        send_notification "FAILED" "Neo4j container not running"
        exit 1
    fi
}

# Perform Neo4j backup using neo4j-admin dump
perform_backup() {
    log_info "Starting Neo4j backup..."
    log_info "Database: ${NEO4J_DATABASE}, Container: ${NEO4J_CONTAINER}"

    local backup_path="${BACKUP_DIR}/daily/${BACKUP_FILE}"

    # Create temporary directory for dump inside container
    local container_backup_dir="/tmp/neo4j-backup-${TIMESTAMP}"

    # Execute neo4j-admin dump inside container
    log_info "Executing neo4j-admin dump in container..."
    if docker exec "${NEO4J_CONTAINER}" \
        neo4j-admin database dump \
        --database="${NEO4J_DATABASE}" \
        --to-path=/tmp \
        --overwrite-destination=true 2>&1 | grep -v "^$"; then

        log_success "Database dump created in container"
    else
        log_error "Database dump failed"
        send_notification "FAILED" "Neo4j backup failed for ${NEO4J_DATABASE}"
        exit 1
    fi

    # Copy dump file from container to host
    log_info "Copying dump file from container to host..."
    local container_dump_file="/tmp/${NEO4J_DATABASE}.dump"

    if docker cp "${NEO4J_CONTAINER}:${container_dump_file}" "${backup_path}"; then
        log_success "Dump file copied to: ${backup_path}"
    else
        log_error "Failed to copy dump file from container"
        send_notification "FAILED" "Failed to copy Neo4j dump from container"
        exit 1
    fi

    # Clean up dump file in container
    docker exec "${NEO4J_CONTAINER}" rm -f "${container_dump_file}" 2>/dev/null || true

    # Get backup size before compression
    local backup_size=$(du -h "${backup_path}" | cut -f1)
    log_info "Backup size (uncompressed): ${backup_size}"

    # Compress backup
    log_info "Compressing backup..."
    if gzip -9 "${backup_path}"; then
        log_success "Backup compressed: ${backup_path}.gz"
    else
        log_error "Compression failed"
        send_notification "WARNING" "Neo4j backup created but compression failed"
        exit 1
    fi

    # Get compressed size
    local compressed_size=$(du -h "${backup_path}.gz" | cut -f1)
    log_info "Backup size (compressed): ${compressed_size}"

    echo "${backup_path}.gz"
}

# Verify backup integrity
verify_backup() {
    local backup_file="$1"

    log_info "Verifying backup integrity..."

    # Test gzip integrity
    if gzip -t "${backup_file}"; then
        log_success "Backup integrity verified"
        return 0
    else
        log_error "Backup integrity check failed"
        send_notification "FAILED" "Neo4j backup verification failed"
        return 1
    fi
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
    find "${BACKUP_DIR}/daily" -name "neo4j_*.dump.gz" -type f -mtime +${RETENTION_DAILY} -delete

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
    log_info "Database: ${NEO4J_DATABASE}"
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
    log_info "===== HappyCMDB Neo4j Backup ====="

    # Check if container is running
    check_container

    # Create directory structure
    create_backup_dirs

    # Perform backup
    backup_file=$(perform_backup)

    # Verify backup
    if ! verify_backup "${backup_file}"; then
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
    send_notification "SUCCESS" "Neo4j backup completed successfully (${NEO4J_DATABASE})"

    log_success "Backup completed successfully!"
}

# Run main function
main "$@"
