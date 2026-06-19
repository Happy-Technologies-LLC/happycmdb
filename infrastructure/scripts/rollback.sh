#!/bin/bash

# =============================================================================
# HappyCMDB - Automated Rollback Script
# =============================================================================
# Rollback to previous state after failed deployment:
# - Stop current (failed) containers
# - Restore previous Docker containers
# - Rollback database migrations (if safe)
# - Restore database from backup (if needed)
# - Verify system health
# - Send notifications
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Functions
log_info() {
    echo -e "${BLUE}ℹ${NC} $1" | tee -a "$ROLLBACK_LOG"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1" | tee -a "$ROLLBACK_LOG"
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1" | tee -a "$ROLLBACK_LOG"
}

log_error() {
    echo -e "${RED}✗${NC} $1" | tee -a "$ROLLBACK_LOG"
}

log_critical() {
    echo -e "${MAGENTA}🚨${NC} $1" | tee -a "$ROLLBACK_LOG"
}

print_header() {
    echo "" | tee -a "$ROLLBACK_LOG"
    echo "==========================================="  | tee -a "$ROLLBACK_LOG"
    echo "$1" | tee -a "$ROLLBACK_LOG"
    echo "==========================================="  | tee -a "$ROLLBACK_LOG"
    echo "" | tee -a "$ROLLBACK_LOG"
}

# Send notification (Slack, Teams, email, etc.)
send_notification() {
    local status=$1
    local message=$2
    local webhook="${DEPLOYMENT_NOTIFICATION_WEBHOOK:-}"

    if [[ -n "$webhook" ]]; then
        curl -X POST "$webhook" \
            -H 'Content-Type: application/json' \
            -d "{\"text\":\"[HappyCMDB ROLLBACK] $status: $message\"}" \
            > /dev/null 2>&1 || true
    fi
}

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/happycmdb}"
ROLLBACK_LOG="$PROJECT_ROOT/logs/rollback-$(date +%Y%m%d-%H%M%S).log"

# Create log directory
mkdir -p "$(dirname "$ROLLBACK_LOG")"

print_header "HappyCMDB - ROLLBACK PROCEDURE"
log_critical "ROLLBACK INITIATED"
log_info "Rollback started at: $(date)"
log_info "Rollback log: $ROLLBACK_LOG"
log_info "Operator: ${USER:-unknown}"

# =============================================================================
# Parse Arguments
# =============================================================================
BACKUP_TIMESTAMP="${1:-}"
ROLLBACK_TYPE="${2:-full}"  # full, containers-only, database-only

if [[ -z "$BACKUP_TIMESTAMP" ]]; then
    log_error "Usage: $0 <backup-timestamp> [full|containers-only|database-only]"
    echo ""
    echo "Available backups:"
    ls -lh "$BACKUP_DIR" 2>/dev/null | grep "^d" | awk '{print $9}' || echo "No backups found"
    exit 1
fi

BACKUP_PATH="$BACKUP_DIR/$BACKUP_TIMESTAMP"

if [[ ! -d "$BACKUP_PATH" ]]; then
    log_error "Backup not found: $BACKUP_PATH"
    echo ""
    echo "Available backups:"
    ls -lh "$BACKUP_DIR" 2>/dev/null | grep "^d" | awk '{print $9}' || echo "No backups found"
    exit 1
fi

log_info "Backup path: $BACKUP_PATH"
log_info "Rollback type: $ROLLBACK_TYPE"

# =============================================================================
# Confirmation
# =============================================================================
echo ""
log_warning "═══════════════════════════════════════════"
log_warning "  ROLLBACK CONFIRMATION"
log_warning "═══════════════════════════════════════════"
echo ""
echo "You are about to rollback to a previous state."
echo ""
echo "Rollback details:"
echo "  Backup: $BACKUP_TIMESTAMP"
echo "  Path: $BACKUP_PATH"
echo "  Type: $ROLLBACK_TYPE"
echo "  Date: $(date)"
echo "  Operator: ${USER:-unknown}"
echo ""
echo "This will:"
if [[ "$ROLLBACK_TYPE" == "full" || "$ROLLBACK_TYPE" == "containers-only" ]]; then
    echo "  • Stop current containers"
    echo "  • Restore previous container state"
fi
if [[ "$ROLLBACK_TYPE" == "full" || "$ROLLBACK_TYPE" == "database-only" ]]; then
    echo "  • Restore database backups"
fi
echo ""
echo -n "Type 'ROLLBACK' to continue: "
read -r confirmation

if [[ "$confirmation" != "ROLLBACK" ]]; then
    log_error "Rollback cancelled"
    exit 1
fi

log_success "Rollback confirmed"
send_notification "STARTED" "Rollback initiated by ${USER:-unknown} to backup: $BACKUP_TIMESTAMP"

# =============================================================================
# STEP 1: Verify Backup Integrity
# =============================================================================
print_header "Step 1: Verifying Backup Integrity"

# Check for required backup files
BACKUP_VALID=true

if [[ "$ROLLBACK_TYPE" == "full" || "$ROLLBACK_TYPE" == "database-only" ]]; then
    # Check Neo4j backup
    if [[ -f "$BACKUP_PATH/neo4j-backup.tar.gz" ]]; then
        log_info "Verifying Neo4j backup..."
        if tar -tzf "$BACKUP_PATH/neo4j-backup.tar.gz" > /dev/null 2>&1; then
            log_success "Neo4j backup is valid"
        else
            log_error "Neo4j backup is corrupted"
            BACKUP_VALID=false
        fi
    else
        log_warning "Neo4j backup not found"
    fi

    # Check PostgreSQL backup
    if [[ -f "$BACKUP_PATH/postgres-backup.sql.gz" ]]; then
        log_info "Verifying PostgreSQL backup..."
        if gunzip -t "$BACKUP_PATH/postgres-backup.sql.gz" 2>&1; then
            log_success "PostgreSQL backup is valid"
        else
            log_error "PostgreSQL backup is corrupted"
            BACKUP_VALID=false
        fi
    else
        log_warning "PostgreSQL backup not found"
    fi
fi

if [[ "$BACKUP_VALID" == false ]]; then
    log_error "Backup validation failed - cannot proceed with rollback"
    exit 1
fi

log_success "Backup integrity verified"

# =============================================================================
# STEP 2: Create Safety Snapshot
# =============================================================================
print_header "Step 2: Creating Safety Snapshot"

SAFETY_SNAPSHOT_DIR="$BACKUP_DIR/safety-snapshot-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SAFETY_SNAPSHOT_DIR"

log_info "Creating safety snapshot of current state..."
log_info "Snapshot location: $SAFETY_SNAPSHOT_DIR"

# Save current container state
docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" ps > "$SAFETY_SNAPSHOT_DIR/container-state.txt" 2>&1 || true
docker images | grep happycmdb > "$SAFETY_SNAPSHOT_DIR/image-state.txt" 2>&1 || true

log_success "Safety snapshot created"

# =============================================================================
# STEP 3: Stop Current Containers
# =============================================================================
if [[ "$ROLLBACK_TYPE" == "full" || "$ROLLBACK_TYPE" == "containers-only" ]]; then
    print_header "Step 3: Stopping Current Containers"

    log_info "Stopping all HappyCMDB containers..."
    docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" down 2>&1 | tee -a "$ROLLBACK_LOG"

    # Also stop any green environment containers if they exist
    docker stop cmdb-api-server-green cmdb-web-ui-green 2>/dev/null || true
    docker rm cmdb-api-server-green cmdb-web-ui-green 2>/dev/null || true

    log_success "Containers stopped"
fi

# =============================================================================
# STEP 4: Restore Git State (if available)
# =============================================================================
if [[ "$ROLLBACK_TYPE" == "full" || "$ROLLBACK_TYPE" == "containers-only" ]]; then
    if [[ -f "$BACKUP_PATH/git-commit.txt" ]]; then
        print_header "Step 4: Restoring Git State"

        PREVIOUS_COMMIT=$(cat "$BACKUP_PATH/git-commit.txt")
        log_info "Checking out commit: $PREVIOUS_COMMIT"

        cd "$PROJECT_ROOT"

        # Stash any uncommitted changes
        git stash push -m "Pre-rollback stash $(date)" 2>&1 | tee -a "$ROLLBACK_LOG" || true

        # Checkout previous commit
        git checkout "$PREVIOUS_COMMIT" 2>&1 | tee -a "$ROLLBACK_LOG"

        log_success "Git state restored to: $PREVIOUS_COMMIT"
    else
        log_warning "Git commit information not found in backup - skipping git restore"
    fi
fi

# =============================================================================
# STEP 5: Restore Database Backups
# =============================================================================
if [[ "$ROLLBACK_TYPE" == "full" || "$ROLLBACK_TYPE" == "database-only" ]]; then
    print_header "Step 5: Restoring Database Backups"

    # Start infrastructure containers if not running
    log_info "Ensuring infrastructure containers are running..."
    docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" up -d neo4j postgres redis 2>&1 | tee -a "$ROLLBACK_LOG"
    sleep 15

    # Restore Neo4j
    if [[ -f "$BACKUP_PATH/neo4j-backup.tar.gz" ]]; then
        log_info "Restoring Neo4j database..."

        if [[ -f "$SCRIPT_DIR/restore-neo4j.sh" ]]; then
            bash "$SCRIPT_DIR/restore-neo4j.sh" "$BACKUP_PATH/neo4j-backup.tar.gz" 2>&1 | tee -a "$ROLLBACK_LOG"
            log_success "Neo4j restored"
        else
            log_error "restore-neo4j.sh not found - manual restore required"
            log_info "Backup location: $BACKUP_PATH/neo4j-backup.tar.gz"
        fi
    fi

    # Restore PostgreSQL
    if [[ -f "$BACKUP_PATH/postgres-backup.sql.gz" ]]; then
        log_info "Restoring PostgreSQL database..."

        if [[ -f "$SCRIPT_DIR/restore-postgres.sh" ]]; then
            bash "$SCRIPT_DIR/restore-postgres.sh" "$BACKUP_PATH/postgres-backup.sql.gz" 2>&1 | tee -a "$ROLLBACK_LOG"
            log_success "PostgreSQL restored"
        else
            log_error "restore-postgres.sh not found - manual restore required"
            log_info "Backup location: $BACKUP_PATH/postgres-backup.sql.gz"
        fi
    fi
fi

# =============================================================================
# STEP 6: Rebuild Application Containers
# =============================================================================
if [[ "$ROLLBACK_TYPE" == "full" || "$ROLLBACK_TYPE" == "containers-only" ]]; then
    print_header "Step 6: Rebuilding Application Containers"

    cd "$PROJECT_ROOT"

    # Install dependencies
    log_info "Installing dependencies..."
    npm install --production=false 2>&1 | tee -a "$ROLLBACK_LOG"

    # Build TypeScript packages
    log_info "Building TypeScript packages..."

    PACKAGES=(
        "common"
        "database"
        "event-processor"
        "integration-framework"
        "data-mapper"
        "identity-resolution"
        "integration-hub"
        "ai-ml-engine"
        "discovery-engine"
        "etl-processor"
        "api-server"
    )

    for pkg in "${PACKAGES[@]}"; do
        if [[ -d "packages/$pkg" ]]; then
            log_info "Building @cmdb/$pkg..."
            (cd "packages/$pkg" && npm run build) 2>&1 | tee -a "$ROLLBACK_LOG"
        fi
    done

    log_success "Packages built"

    # Build Docker images
    log_info "Building Docker images..."
    docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" build --no-cache api-server web-ui 2>&1 | tee -a "$ROLLBACK_LOG"

    log_success "Docker images built"
fi

# =============================================================================
# STEP 7: Start Application Containers
# =============================================================================
if [[ "$ROLLBACK_TYPE" == "full" || "$ROLLBACK_TYPE" == "containers-only" ]]; then
    print_header "Step 7: Starting Application Containers"

    log_info "Starting all containers..."
    docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" up -d 2>&1 | tee -a "$ROLLBACK_LOG"

    log_info "Waiting for containers to initialize (30 seconds)..."
    sleep 30

    log_success "Containers started"
fi

# =============================================================================
# STEP 8: Verify System Health
# =============================================================================
print_header "Step 8: Verifying System Health"

API_PORT="${API_PORT:-3000}"
WEB_UI_PORT="${WEB_UI_PORT:-3001}"

check_service_health() {
    local service=$1
    local url=$2
    local max_attempts=30

    log_info "Checking $service health..."

    for attempt in $(seq 1 $max_attempts); do
        if curl -sf "$url" > /dev/null 2>&1; then
            log_success "$service is healthy"
            return 0
        fi
        sleep 2
    done

    log_error "$service failed health check"
    return 1
}

HEALTH_CHECK_PASSED=true

# Check API
check_service_health "API Server" "http://localhost:$API_PORT/api/v1/health" || HEALTH_CHECK_PASSED=false

# Check Web UI
check_service_health "Web UI" "http://localhost:$WEB_UI_PORT" || HEALTH_CHECK_PASSED=false

# Check databases
log_info "Checking database connectivity..."

NEO4J_PASSWORD="${NEO4J_PASSWORD:-cmdb_password_dev}"
if docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" "RETURN 1" > /dev/null 2>&1; then
    log_success "Neo4j connection verified"
else
    log_error "Neo4j connection failed"
    HEALTH_CHECK_PASSED=false
fi

POSTGRES_USER="${POSTGRES_USER:-cmdb_user}"
POSTGRES_DB="${POSTGRES_DATABASE:-cmdb}"
if docker exec cmdb-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1" > /dev/null 2>&1; then
    log_success "PostgreSQL connection verified"
else
    log_error "PostgreSQL connection failed"
    HEALTH_CHECK_PASSED=false
fi

if docker exec cmdb-redis redis-cli ping > /dev/null 2>&1; then
    log_success "Redis connection verified"
else
    log_error "Redis connection failed"
    HEALTH_CHECK_PASSED=false
fi

# =============================================================================
# STEP 9: Run Post-Rollback Validation
# =============================================================================
print_header "Step 9: Post-Rollback Validation"

if [[ -f "$SCRIPT_DIR/post-deploy-validation.sh" ]]; then
    log_info "Running comprehensive post-rollback validation..."
    bash "$SCRIPT_DIR/post-deploy-validation.sh" 2>&1 | tee -a "$ROLLBACK_LOG"
else
    log_warning "post-deploy-validation.sh not found - skipping validation"
fi

# =============================================================================
# ROLLBACK SUMMARY
# =============================================================================
print_header "Rollback Summary"

log_info "Rollback completed at: $(date)"
log_info "Rollback log: $ROLLBACK_LOG"
log_info "Safety snapshot: $SAFETY_SNAPSHOT_DIR"

if [[ "$HEALTH_CHECK_PASSED" == true ]]; then
    log_success "ROLLBACK SUCCESSFUL - System is healthy"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Rollback Complete"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "✅ Status: SUCCESS"
    echo "📅 Date: $(date)"
    echo "👤 Operator: ${USER:-unknown}"
    echo "💾 Backup: $BACKUP_TIMESTAMP"
    echo "🛟 Safety Snapshot: $SAFETY_SNAPSHOT_DIR"
    echo ""
    echo "📊 Container Status:"
    docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" ps
    echo ""
    echo "📝 Next Steps:"
    echo "  1. Monitor system for 30 minutes"
    echo "  2. Review rollback logs: $ROLLBACK_LOG"
    echo "  3. Investigate root cause of deployment failure"
    echo "  4. Plan remediation steps"
    echo "  5. Notify stakeholders"
    echo ""

    send_notification "SUCCESS" "Rollback completed successfully by ${USER:-unknown}"
    exit 0
else
    log_error "ROLLBACK COMPLETED WITH ERRORS"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Rollback Completed with Errors"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "⚠️  Some health checks failed - manual intervention required"
    echo ""
    echo "📝 Troubleshooting:"
    echo "  1. Review rollback log: $ROLLBACK_LOG"
    echo "  2. Check container logs: docker-compose -f infrastructure/docker/docker-compose.yml logs"
    echo "  3. Verify database connections manually"
    echo "  4. Contact system administrator if issues persist"
    echo ""

    send_notification "PARTIAL" "Rollback completed with errors - manual intervention needed"
    exit 1
fi
