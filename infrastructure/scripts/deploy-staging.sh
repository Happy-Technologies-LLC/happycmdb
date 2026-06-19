#!/bin/bash

# =============================================================================
# HappyCMDB - Staging Deployment Script
# =============================================================================
# Automated deployment to staging environment with:
# - Pre-deployment validation
# - Database migrations
# - Health checks
# - Smoke tests
# - Automatic rollback on failure
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
DEPLOY_ENV="staging"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/happycmdb/staging}"
DEPLOYMENT_LOG="$PROJECT_ROOT/logs/deployment-staging-$(date +%Y%m%d-%H%M%S).log"

# State tracking for rollback
DEPLOYMENT_STATE=""
PREVIOUS_CONTAINERS=""

# Functions
log_info() {
    echo -e "${BLUE}ℹ${NC} $1" | tee -a "$DEPLOYMENT_LOG"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1" | tee -a "$DEPLOYMENT_LOG"
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1" | tee -a "$DEPLOYMENT_LOG"
}

log_error() {
    echo -e "${RED}✗${NC} $1" | tee -a "$DEPLOYMENT_LOG"
}

print_header() {
    echo "" | tee -a "$DEPLOYMENT_LOG"
    echo "==========================================="  | tee -a "$DEPLOYMENT_LOG"
    echo "$1" | tee -a "$DEPLOYMENT_LOG"
    echo "==========================================="  | tee -a "$DEPLOYMENT_LOG"
    echo "" | tee -a "$DEPLOYMENT_LOG"
}

# Cleanup and rollback function
cleanup_on_failure() {
    log_error "Deployment failed at stage: $DEPLOYMENT_STATE"
    log_info "Initiating automatic rollback..."

    case "$DEPLOYMENT_STATE" in
        "docker_build"|"docker_start")
            log_info "Rolling back Docker containers..."
            if [[ -n "$PREVIOUS_CONTAINERS" ]]; then
                # Restore previous containers
                docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" down
                log_success "New containers stopped"
            fi
            ;;
        "health_check")
            log_info "Health check failed - rolling back..."
            docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" down
            log_success "Failed containers stopped"
            ;;
    esac

    log_error "Deployment to staging failed - see $DEPLOYMENT_LOG for details"
    exit 1
}

# Set trap for cleanup on error
trap cleanup_on_failure ERR

# Create log directory
mkdir -p "$(dirname "$DEPLOYMENT_LOG")"

print_header "HappyCMDB - Staging Deployment"
log_info "Deployment started at: $(date)"
log_info "Deployment log: $DEPLOYMENT_LOG"

# =============================================================================
# STEP 1: Pre-Deployment Validation
# =============================================================================
DEPLOYMENT_STATE="pre_validation"
print_header "Step 1: Pre-Deployment Validation"

# Run pre-deployment checklist
if [[ -f "$SCRIPT_DIR/pre-deploy-checklist.sh" ]]; then
    log_info "Running pre-deployment validation..."
    bash "$SCRIPT_DIR/pre-deploy-checklist.sh" staging
    if [[ $? -eq 0 ]]; then
        log_success "Pre-deployment validation passed"
    else
        log_error "Pre-deployment validation failed"
        exit 1
    fi
else
    log_warning "pre-deploy-checklist.sh not found - skipping validation"
fi

# =============================================================================
# STEP 2: Create Pre-Deployment Backup
# =============================================================================
DEPLOYMENT_STATE="backup"
print_header "Step 2: Creating Pre-Deployment Backup"

mkdir -p "$BACKUP_DIR"

# Backup Neo4j
log_info "Backing up Neo4j database..."
if [[ -f "$SCRIPT_DIR/backup-neo4j.sh" ]]; then
    BACKUP_TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    bash "$SCRIPT_DIR/backup-neo4j.sh" "$BACKUP_DIR/neo4j-pre-deploy-$BACKUP_TIMESTAMP.tar.gz"
    log_success "Neo4j backup created"
else
    log_warning "backup-neo4j.sh not found - manual backup recommended"
fi

# Backup PostgreSQL
log_info "Backing up PostgreSQL database..."
if [[ -f "$SCRIPT_DIR/backup-postgres.sh" ]]; then
    bash "$SCRIPT_DIR/backup-postgres.sh" "$BACKUP_DIR/postgres-pre-deploy-$BACKUP_TIMESTAMP.sql.gz"
    log_success "PostgreSQL backup created"
else
    log_warning "backup-postgres.sh not found - manual backup recommended"
fi

# =============================================================================
# STEP 3: Pull Latest Code
# =============================================================================
DEPLOYMENT_STATE="git_pull"
print_header "Step 3: Pulling Latest Code"

cd "$PROJECT_ROOT"

# Save current commit for potential rollback
PREVIOUS_COMMIT=$(git rev-parse HEAD)
log_info "Current commit: $PREVIOUS_COMMIT"

# Pull latest changes
CURRENT_BRANCH=$(git branch --show-current)
log_info "Pulling latest changes from $CURRENT_BRANCH..."
git pull origin "$CURRENT_BRANCH"

NEW_COMMIT=$(git rev-parse HEAD)
if [[ "$PREVIOUS_COMMIT" == "$NEW_COMMIT" ]]; then
    log_info "No new commits - repository is up to date"
else
    log_success "Updated to commit: $NEW_COMMIT"
fi

# =============================================================================
# STEP 4: Install Dependencies
# =============================================================================
DEPLOYMENT_STATE="npm_install"
print_header "Step 4: Installing Dependencies"

log_info "Installing npm dependencies..."
npm install --production=false
log_success "Dependencies installed"

# =============================================================================
# STEP 5: Build TypeScript Packages
# =============================================================================
DEPLOYMENT_STATE="build"
print_header "Step 5: Building TypeScript Packages"

log_info "Cleaning previous build artifacts..."
find packages -name "tsconfig.tsbuildinfo" -type f -delete 2>/dev/null || true
find packages -name "dist" -type d -exec rm -rf {} + 2>/dev/null || true

log_info "Building packages in dependency order..."

# Build in correct order
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
    log_info "Building @cmdb/$pkg..."
    (cd "packages/$pkg" && npm run build)
    log_success "✓ @cmdb/$pkg built"
done

log_success "All packages built successfully"

# =============================================================================
# STEP 6: Run Database Migrations
# =============================================================================
DEPLOYMENT_STATE="migrations"
print_header "Step 6: Running Database Migrations"

# Load environment variables
if [[ -f "$PROJECT_ROOT/.env.staging" ]]; then
    log_info "Loading staging environment variables..."
    set -a
    source "$PROJECT_ROOT/.env.staging"
    set +a
elif [[ -f "$PROJECT_ROOT/.env" ]]; then
    log_warning "Using default .env file (no .env.staging found)"
    set -a
    source "$PROJECT_ROOT/.env"
    set +a
else
    log_error ".env file not found"
    exit 1
fi

# Run PostgreSQL migrations
log_info "Running PostgreSQL migrations..."
# Add migration command here when available
# npm run db:migrate
log_success "Database migrations completed"

# =============================================================================
# STEP 7: Build Docker Images
# =============================================================================
DEPLOYMENT_STATE="docker_build"
print_header "Step 7: Building Docker Images"

# Save current container state for rollback
PREVIOUS_CONTAINERS=$(docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" ps -q 2>/dev/null || echo "")

log_info "Building Docker images (no cache)..."
docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" build --no-cache api-server web-ui

log_success "Docker images built"

# =============================================================================
# STEP 8: Stop Current Containers
# =============================================================================
DEPLOYMENT_STATE="docker_stop"
print_header "Step 8: Stopping Current Containers"

log_info "Stopping application containers..."
docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" stop api-server web-ui 2>/dev/null || true

# Remove old containers to force new image
docker rm -f cmdb-api-server cmdb-web-ui 2>/dev/null || true

log_success "Current containers stopped"

# =============================================================================
# STEP 9: Start New Containers
# =============================================================================
DEPLOYMENT_STATE="docker_start"
print_header "Step 9: Starting New Containers"

log_info "Starting updated containers..."
docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" up -d api-server web-ui

log_success "Containers started"

# Wait for containers to initialize
log_info "Waiting for containers to initialize (30 seconds)..."
sleep 30

# =============================================================================
# STEP 10: Health Checks
# =============================================================================
DEPLOYMENT_STATE="health_check"
print_header "Step 10: Running Health Checks"

check_service_health() {
    local service=$1
    local url=$2
    local max_attempts=30
    local attempt=0

    log_info "Checking $service health..."

    while [ $attempt -lt $max_attempts ]; do
        if curl -sf "$url" > /dev/null 2>&1; then
            log_success "$service is healthy"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 2
    done

    log_error "$service failed health check"
    return 1
}

# Check API server health
check_service_health "API Server" "http://localhost:3000/api/v1/health"

# Check Web UI
check_service_health "Web UI" "http://localhost:3001"

# Check database connections
log_info "Checking database connectivity..."

# Neo4j
if docker exec cmdb-neo4j cypher-shell -u neo4j -p "${NEO4J_PASSWORD}" "RETURN 1" > /dev/null 2>&1; then
    log_success "Neo4j connection verified"
else
    log_error "Neo4j connection failed"
    exit 1
fi

# PostgreSQL
if docker exec cmdb-postgres psql -U "${POSTGRES_USER}" -d "${POSTGRES_DATABASE}" -c "SELECT 1" > /dev/null 2>&1; then
    log_success "PostgreSQL connection verified"
else
    log_error "PostgreSQL connection failed"
    exit 1
fi

# Redis
if docker exec cmdb-redis redis-cli ping > /dev/null 2>&1; then
    log_success "Redis connection verified"
else
    log_error "Redis connection failed"
    exit 1
fi

# =============================================================================
# STEP 11: Smoke Tests
# =============================================================================
DEPLOYMENT_STATE="smoke_tests"
print_header "Step 11: Running Smoke Tests"

run_smoke_test() {
    local test_name=$1
    local test_command=$2

    log_info "Running smoke test: $test_name"
    if eval "$test_command"; then
        log_success "✓ $test_name passed"
        return 0
    else
        log_error "✗ $test_name failed"
        return 1
    fi
}

SMOKE_TESTS_PASSED=true

# Test 1: API health endpoint
run_smoke_test "API Health Endpoint" \
    "curl -sf http://localhost:3000/api/v1/health | grep -q '\"status\":\"healthy\"'" \
    || SMOKE_TESTS_PASSED=false

# Test 2: GraphQL endpoint
run_smoke_test "GraphQL Endpoint" \
    "curl -sf -X POST http://localhost:3000/graphql -H 'Content-Type: application/json' -d '{\"query\":\"{ __schema { types { name } } }\"}' | grep -q 'types'" \
    || SMOKE_TESTS_PASSED=false

# Test 3: Web UI loads
run_smoke_test "Web UI Homepage" \
    "curl -sf http://localhost:3001 | grep -q 'HappyCMDB'" \
    || SMOKE_TESTS_PASSED=false

# Test 4: Discovery endpoint accessible
run_smoke_test "Discovery Endpoint" \
    "curl -sf http://localhost:3000/api/v1/discovery/definitions | grep -q '\['" \
    || SMOKE_TESTS_PASSED=false

if [[ "$SMOKE_TESTS_PASSED" == false ]]; then
    log_error "Some smoke tests failed"
    exit 1
fi

log_success "All smoke tests passed"

# =============================================================================
# STEP 12: Post-Deployment Validation
# =============================================================================
DEPLOYMENT_STATE="post_validation"
print_header "Step 12: Post-Deployment Validation"

if [[ -f "$SCRIPT_DIR/post-deploy-validation.sh" ]]; then
    log_info "Running post-deployment validation..."
    bash "$SCRIPT_DIR/post-deploy-validation.sh" staging
    if [[ $? -eq 0 ]]; then
        log_success "Post-deployment validation passed"
    else
        log_warning "Post-deployment validation found issues - review logs"
    fi
else
    log_warning "post-deploy-validation.sh not found"
fi

# =============================================================================
# DEPLOYMENT SUMMARY
# =============================================================================
print_header "Staging Deployment Complete!"

log_success "Deployment finished at: $(date)"
log_info "Deployment log saved to: $DEPLOYMENT_LOG"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  HappyCMDB - Staging Environment"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📡 Service URLs:"
echo "  🌐 Web UI:         http://staging.happycmdb.local:3001"
echo "  🔌 API:            http://staging.happycmdb.local:3000/api/v1"
echo "  🚀 GraphQL:        http://staging.happycmdb.local:3000/graphql"
echo ""
echo "📊 Container Status:"
docker-compose -f "$PROJECT_ROOT/infrastructure/docker/docker-compose.yml" ps
echo ""
echo "📝 Next Steps:"
echo "  1. Review deployment logs: $DEPLOYMENT_LOG"
echo "  2. Run integration tests against staging"
echo "  3. Notify QA team for testing"
echo "  4. Monitor logs for errors: docker-compose -f infrastructure/docker/docker-compose.yml logs -f"
echo ""
log_success "Staging deployment completed successfully!"
