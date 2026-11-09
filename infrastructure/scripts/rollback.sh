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
# HAP-1762/HAP-1748: replacing the live PostgreSQL or Neo4j database is an argv opt-in plus a typed confirmation; no
# environment variable enables either.
REPLACE_LIVE_POSTGRES=false
REPLACE_LIVE_NEO4J=false
PG_DATABASE="${POSTGRES_DATABASE:-cmdb}"
usage_error=false
for flag in "${@:3}"; do
    case "$flag" in
        --replace-live-postgres) [[ "$REPLACE_LIVE_POSTGRES" == false ]] && REPLACE_LIVE_POSTGRES=true || usage_error=true ;;
        --replace-live-neo4j) [[ "$REPLACE_LIVE_NEO4J" == false ]] && REPLACE_LIVE_NEO4J=true || usage_error=true ;;
        *) usage_error=true ;;
    esac
done
if [[ "$usage_error" == true || ( $# -gt 2 && "$ROLLBACK_TYPE" == "containers-only" ) ]]; then
    log_error "Usage: $0 <backup-timestamp> [full|database-only] [--replace-live-postgres] [--replace-live-neo4j]"
    exit 1
fi

if [[ -z "$BACKUP_TIMESTAMP" ]]; then
    log_error "Usage: $0 <backup-timestamp> [full|containers-only|database-only] [--replace-live-postgres] [--replace-live-neo4j]"
    echo ""
    echo "Available backups:"
    ls -lh "$BACKUP_DIR" 2>/dev/null | grep "^d" | awk '{print $9}' || echo "No backups found"
    exit 1
fi

BACKUP_PATH="$BACKUP_DIR/$BACKUP_TIMESTAMP"
NEO4J_BACKUP="$BACKUP_PATH/neo4j-backup.dump.gz"

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
    if [[ "$REPLACE_LIVE_POSTGRES" == true ]]; then
        echo "  • DROP and replace the live PostgreSQL database '$PG_DATABASE' (after a verified pre-restore backup)"
    fi
    if [[ "$REPLACE_LIVE_NEO4J" == true ]]; then
        echo "  • Stop Neo4j and overwrite the live Neo4j database 'neo4j' (after a verified pre-restore dump)"
    fi
fi
echo ""
echo -n "Type 'ROLLBACK' to continue: "
read -r confirmation

if [[ "$confirmation" != "ROLLBACK" ]]; then
    log_error "Rollback cancelled"
    exit 1
fi

if [[ "$REPLACE_LIVE_POSTGRES" == true ]]; then
    echo -n "Type 'REPLACE $PG_DATABASE' to drop and replace the live PostgreSQL database: "
    read -r replace_confirmation
    if [[ "$replace_confirmation" != "REPLACE $PG_DATABASE" ]]; then
        log_error "Rollback cancelled: PostgreSQL replace not confirmed"
        exit 1
    fi
fi

if [[ "$REPLACE_LIVE_NEO4J" == true ]]; then
    echo -n "Type 'REPLACE neo4j' to stop Neo4j and overwrite the live Neo4j database: "
    read -r replace_confirmation
    if [[ "$replace_confirmation" != "REPLACE neo4j" ]]; then
        log_error "Rollback cancelled: Neo4j replace not confirmed"
        exit 1
    fi
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
    # HAP-1748: the deploy's Neo4j backup (backup-neo4j.sh --to). Community Edition's one database, neo4j, always
    # exists, so restoring it always replaces the live database: without --replace-live-neo4j nothing is touched.
    if [[ -f "$NEO4J_BACKUP" ]]; then
        if [[ "$REPLACE_LIVE_NEO4J" != true ]]; then
            log_error "Neo4j backup present ($NEO4J_BACKUP): restoring it overwrites the live Neo4j database - rerun with --replace-live-neo4j"
            BACKUP_VALID=false
        else
            log_info "Verifying Neo4j backup..."
            bash "$SCRIPT_DIR/restore-neo4j.sh" --file "$NEO4J_BACKUP" --check </dev/null 2>&1 | tee -a "$ROLLBACK_LOG"
            if [[ "${PIPESTATUS[0]}" -eq 0 ]]; then
                log_success "Neo4j backup is valid"
            else
                log_error "Neo4j backup failed verification"
                BACKUP_VALID=false
            fi
        fi
    elif [[ "$REPLACE_LIVE_NEO4J" == true ]]; then
        log_error "--replace-live-neo4j given, but there is no Neo4j backup: $NEO4J_BACKUP"
        BACKUP_VALID=false
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

# HAP-1762/HAP-1748: a full rollback's Step 4 checks out the previous commit, which may carry restore scripts without
# the flags Step 5 passes. Step 5 runs these copies of the scripts this rollback started with.
PG_RESTORE_SCRIPT="$SAFETY_SNAPSHOT_DIR/restore-postgres.sh"
if [[ -f "$SCRIPT_DIR/restore-postgres.sh" ]]; then
    cp "$SCRIPT_DIR/restore-postgres.sh" "$PG_RESTORE_SCRIPT"
fi
NEO4J_RESTORE_SCRIPT="$SAFETY_SNAPSHOT_DIR/restore-neo4j.sh"
if [[ -f "$SCRIPT_DIR/restore-neo4j.sh" && -f "$SCRIPT_DIR/neo4j-offline.sh" ]]; then
    cp "$SCRIPT_DIR/restore-neo4j.sh" "$SCRIPT_DIR/neo4j-offline.sh" "$SAFETY_SNAPSHOT_DIR/"
fi
GRANTS_PENDING=false

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

    NEO4J_RESTORED=false
    PG_BACKUP="$BACKUP_PATH/postgres-backup.sql.gz"
    PG_PRE_BACKUP="$SAFETY_SNAPSHOT_DIR/postgres-pre-restore-$PG_DATABASE.sql.gz"
    PG_ARGS=(--file "$PG_BACKUP" --verify)
    if [[ "$REPLACE_LIVE_POSTGRES" == true ]]; then
        PG_ARGS+=(--replace-live --pre-restore-backup "$PG_PRE_BACKUP")
    fi
    API_STOPPED=false

    # HAP-1749/HAP-1762: the backup goes in via --file (a bare path hits usage(), which exits 0). Exported RESTORE_*
    # overrides are pinned, so no environment value makes it --drop or load over a live database: only the argv opt-in
    # (--replace-live) replaces one. stdin is detached (no second prompt). The restore's own status (not tee's) decides.
    restore_postgres() {
        RESTORE_DROP_DATABASE=false RESTORE_CREATE_DATABASE=true bash "$PG_RESTORE_SCRIPT" "${PG_ARGS[@]}" "$@" </dev/null 2>&1 | tee -a "$ROLLBACK_LOG"
        return "${PIPESTATUS[0]}"
    }

    # HAP-1762: everything that can refuse the PostgreSQL restore runs before Neo4j is touched: the database exists
    # without the opt-in, the server is unreachable, another client is connected, or the pre-restore backup fails.
    if [[ -f "$PG_BACKUP" && -f "$PG_RESTORE_SCRIPT" ]]; then
        if [[ "$REPLACE_LIVE_POSTGRES" == true ]] && docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" ps --services --filter status=running 2>/dev/null | grep -qx api-server; then
            log_info "Stopping api-server (the cmdb database's client) for the PostgreSQL replace..."
            docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" stop api-server 2>&1 | tee -a "$ROLLBACK_LOG"
            API_STOPPED=true
        fi
        restore_postgres --preflight | tee "$SAFETY_SNAPSHOT_DIR/postgres-preflight.out"
        postgres_preflight_status=${PIPESTATUS[0]}
        # A script without --preflight reaches usage(), which exits 0: only the marker line proves the checks ran.
        if [[ "$postgres_preflight_status" -eq 0 ]] && ! grep -qx "HAP-1762 PREFLIGHT OK" "$SAFETY_SNAPSHOT_DIR/postgres-preflight.out"; then
            log_error "$PG_RESTORE_SCRIPT ran no preflight: it does not support --preflight/--replace-live"
            postgres_preflight_status=1
        fi
        if [[ "$postgres_preflight_status" -ne 0 ]]; then
            log_error "PostgreSQL preflight failed (exit $postgres_preflight_status) - nothing restored from $PG_BACKUP; Neo4j and PostgreSQL are untouched"
            if [[ "$API_STOPPED" == true ]]; then
                docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" start api-server 2>&1 | tee -a "$ROLLBACK_LOG"
                log_info "api-server restarted"
            fi
            send_notification "FAILED" "Rollback aborted before any restore: PostgreSQL preflight failed (backup: $BACKUP_TIMESTAMP)"
            exit 1
        fi
        # The pre-restore backup the main call loads over the live database is the one this preflight just wrote.
        PG_ARGS+=(--reuse-pre-restore-backup)
    fi

    # HAP-1748: everything that can refuse the Neo4j restore also runs before anything is replaced: the backup is
    # verified, the container is running, and the pre-restore dump path is new. --preflight changes nothing.
    NEO4J_PRE_BACKUP="$SAFETY_SNAPSHOT_DIR/neo4j-pre-restore.dump.gz"
    restore_neo4j() {
        bash "$NEO4J_RESTORE_SCRIPT" --file "$NEO4J_BACKUP" --replace-live --pre-restore-backup "$NEO4J_PRE_BACKUP" "$@" </dev/null 2>&1 | tee -a "$ROLLBACK_LOG"
        return "${PIPESTATUS[0]}"
    }
    restart_api_if_stopped() {
        if [[ "$API_STOPPED" == true ]]; then
            docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" start api-server 2>&1 | tee -a "$ROLLBACK_LOG"
            log_info "api-server restarted"
        fi
    }
    if [[ -f "$NEO4J_BACKUP" ]]; then
        neo4j_preflight_status=1
        if [[ -f "$NEO4J_RESTORE_SCRIPT" ]]; then
            restore_neo4j --preflight | tee "$SAFETY_SNAPSHOT_DIR/neo4j-preflight.out"
            neo4j_preflight_status=${PIPESTATUS[0]}
        fi
        if [[ "$neo4j_preflight_status" -eq 0 ]] && ! grep -qx "HAP-1748 PREFLIGHT OK" "$SAFETY_SNAPSHOT_DIR/neo4j-preflight.out"; then
            neo4j_preflight_status=1
        fi
        if [[ "$neo4j_preflight_status" -ne 0 ]]; then
            log_error "Neo4j preflight failed (exit $neo4j_preflight_status) - nothing restored from $NEO4J_BACKUP; Neo4j and PostgreSQL are untouched"
            restart_api_if_stopped
            send_notification "FAILED" "Rollback aborted before any restore: Neo4j preflight failed (backup: $BACKUP_TIMESTAMP)"
            exit 1
        fi

        log_info "Restoring Neo4j database (Neo4j is stopped for the load)..."
        restore_neo4j && neo4j_restore_status=0 || neo4j_restore_status=$?
        if [[ "$neo4j_restore_status" -ne 0 ]]; then
            case "$neo4j_restore_status" in
                3) neo4j_state="Neo4j is STOPPED and its store may be partially overwritten: run the command restore-neo4j.sh printed above before starting it" ;;
                4) neo4j_state="Neo4j was loaded but is not verified (not online, or the counts differ): see the command restore-neo4j.sh printed above" ;;
                *) neo4j_state="Neo4j is unchanged (restore-neo4j.sh started it again; if it printed STOPPED, run the docker start it printed)" ;;
            esac
            log_error "Neo4j restore failed (exit $neo4j_restore_status) from $NEO4J_BACKUP - $neo4j_state"
            if [[ -f "$PG_PRE_BACKUP" ]]; then
                log_info "PostgreSQL is untouched; its pre-restore backup: $PG_PRE_BACKUP"
            fi
            if [[ "$neo4j_restore_status" -eq 1 ]]; then
                restart_api_if_stopped
            elif [[ "$API_STOPPED" == true ]]; then
                log_error "api-server stays stopped: start it only once Neo4j is restored"
            fi
            send_notification "FAILED" "Rollback aborted: Neo4j restore failed (exit $neo4j_restore_status, backup: $BACKUP_TIMESTAMP)"
            exit 1
        fi
        log_success "Neo4j restored from $NEO4J_BACKUP (pre-restore dump: $NEO4J_PRE_BACKUP)"
        NEO4J_RESTORED=true
    fi

    # Restore PostgreSQL
    if [[ -f "$PG_BACKUP" ]]; then
        log_info "Restoring PostgreSQL database..."

        if [[ -f "$PG_RESTORE_SCRIPT" ]]; then
            restore_postgres && postgres_restore_status=0 || postgres_restore_status=$?
            if [[ "$postgres_restore_status" -ne 0 ]]; then
                case "$postgres_restore_status" in
                    3) postgres_state="PostgreSQL was DROPPED and NOT restored (the database is absent or empty)" ;;
                    4) postgres_state="PostgreSQL was loaded but does NOT match the backup" ;;
                    *) postgres_state="PostgreSQL NOT restored" ;;
                esac
                log_error "PostgreSQL restore failed (exit $postgres_restore_status) - $postgres_state from $PG_BACKUP"
                if [[ -f "$PG_PRE_BACKUP" ]]; then
                    log_error "Pre-restore backup of the replaced database: $PG_PRE_BACKUP (restore-postgres.sh printed the command that puts it back)"
                fi
                partial_state=""
                if [[ "$NEO4J_RESTORED" == true ]]; then
                    log_error "Neo4j WAS already restored from $NEO4J_BACKUP - Neo4j and PostgreSQL are now from different points in time (Neo4j pre-restore dump: $NEO4J_PRE_BACKUP)"
                    partial_state="; Neo4j already restored, PostgreSQL not"
                fi
                if [[ "$API_STOPPED" == true ]]; then
                    log_error "api-server stays stopped: start it only once PostgreSQL is restored"
                fi
                send_notification "FAILED" "Rollback aborted: PostgreSQL restore failed (exit $postgres_restore_status, backup: $BACKUP_TIMESTAMP)$partial_state"
                exit 1
            fi
            log_success "PostgreSQL restored from $PG_BACKUP - grants NOT restored: apply the post-restore grant step printed above"
            GRANTS_PENDING=true
            if [[ "$API_STOPPED" == true ]]; then
                docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" start api-server 2>&1 | tee -a "$ROLLBACK_LOG"
                log_info "api-server restarted"
            fi
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

# HAP-1647: name-only -e passes the exported value via the environment, never argv.
if [[ -z "${NEO4J_PASSWORD:-}" ]]; then
    log_error "Neo4j connection not tested: NEO4J_PASSWORD is not set"
    HEALTH_CHECK_PASSED=false
elif docker exec -e NEO4J_PASSWORD cmdb-neo4j cypher-shell -u neo4j "RETURN 1" > /dev/null 2>&1; then
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
    if [[ "$GRANTS_PENDING" == true ]]; then
        log_warning 'Rollback complete - POST-RESTORE GRANTS PENDING (see runbook "Post-restore grants")'
    else
        log_success "ROLLBACK SUCCESSFUL - System is healthy"
    fi
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Rollback Complete"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    if [[ "$GRANTS_PENDING" == true ]]; then
        echo "⚠️  Status: COMPLETE - POST-RESTORE GRANTS PENDING"
    else
        echo "✅ Status: SUCCESS"
    fi
    echo "📅 Date: $(date)"
    echo "👤 Operator: ${USER:-unknown}"
    echo "💾 Backup: $BACKUP_TIMESTAMP"
    echo "🛟 Safety Snapshot: $SAFETY_SNAPSHOT_DIR"
    echo ""
    echo "📊 Container Status:"
    docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" ps
    echo ""
    echo "📝 Next Steps:"
    step=1
    if [[ "$GRANTS_PENDING" == true ]]; then
        echo "  $((step++)). Apply the post-restore grant step (printed in Step 5; runbook \"Post-restore grants\") before relying on the app"
    fi
    echo "  $((step++)). Monitor system for 30 minutes"
    echo "  $((step++)). Review rollback logs: $ROLLBACK_LOG"
    echo "  $((step++)). Investigate root cause of deployment failure"
    echo "  $((step++)). Plan remediation steps"
    echo "  $((step++)). Notify stakeholders"
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
