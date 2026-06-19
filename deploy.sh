#!/bin/bash

# HappyCMDB - Complete Deployment Script
# Deploys all services: infrastructure + applications + web UI

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Functions
log_info() {
    echo -e "${BLUE}ℹ ${NC} $1"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1"
}

print_header() {
    echo ""
    echo "==========================================="
    echo "$1"
    echo "==========================================="
    echo ""
}

check_health() {
    local service=$1
    local max_attempts=30
    local attempt=0

    log_info "Waiting for $service to be healthy..."

    while [ $attempt -lt $max_attempts ]; do
        if docker-compose -f infrastructure/docker/docker-compose.yml ps $service | grep -q "healthy"; then
            log_success "$service is healthy"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 2
    done

    log_error "$service failed to become healthy"
    return 1
}

# Parse command line arguments
SKIP_BUILD=false
CLEAN_START=false
SEED_DATA=false
PRESERVE_DATA=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --clean)
            CLEAN_START=true
            shift
            ;;
        --seed)
            SEED_DATA=true
            shift
            ;;
        --preserve-data)
            PRESERVE_DATA=true
            shift
            ;;
        --help|-h)
            echo "HappyCMDB Deployment Script"
            echo ""
            echo "Usage: ./deploy.sh [options]"
            echo ""
            echo "Options:"
            echo "  --skip-build      Skip building TypeScript packages"
            echo "  --clean           Clean all Docker volumes and rebuild from scratch"
            echo "  --preserve-data   Keep existing database data (only rebuild app containers)"
            echo "  --seed            Seed database with test data after deployment"
            echo "  --help, -h        Show this help message"
            echo ""
            echo "Examples:"
            echo "  ./deploy.sh                          # Full deployment"
            echo "  ./deploy.sh --clean --seed           # Clean deployment with test data"
            echo "  ./deploy.sh --preserve-data          # Rebuild apps, keep database data"
            echo "  ./deploy.sh --skip-build             # Deploy without rebuilding packages"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Load environment variables if .env exists
if [ -f ".env" ]; then
    log_info "Loading environment variables from .env"
    set -a
    source .env
    set +a
fi

# Start deployment
print_header "HappyCMDB - Complete Deployment"

# Step 1: Clean start or preserve data
if [ "$CLEAN_START" = true ]; then
    log_info "Cleaning Docker environment (including data volumes)..."
    docker-compose -f infrastructure/docker/docker-compose.yml down -v 2>/dev/null || true
    docker system prune -f
    log_success "Docker environment cleaned (all data removed)"
elif [ "$PRESERVE_DATA" = true ]; then
    log_info "Preserving database data (stopping only app containers)..."
    docker-compose -f infrastructure/docker/docker-compose.yml stop api-server web-ui 2>/dev/null || true
    log_success "App containers stopped, database data preserved"
fi

# Step 2: Setup documentation site
print_header "Setting Up Documentation Site"
log_info "Installing documentation site dependencies..."
if [ ! -d "doc-site/node_modules" ]; then
    (cd doc-site && npm install)
    if [ $? -eq 0 ]; then
        log_success "Documentation dependencies installed"
    else
        log_warning "Documentation dependencies installation failed (non-critical)"
    fi
else
    log_success "Documentation dependencies already installed"
fi

# Copy logos if they exist
if [ -f "web-ui/public/assets/logo.svg" ]; then
    mkdir -p doc-site/docs/public/logos
    cp web-ui/public/assets/logo.svg doc-site/docs/public/logos/happycmdb-logo.svg 2>/dev/null || true
    cp web-ui/public/assets/logo.png doc-site/docs/public/logos/happycmdb-logo.png 2>/dev/null || true
    cp web-ui/public/favicon.png doc-site/docs/public/favicon.png 2>/dev/null || true
    log_success "Logos copied to documentation site"
fi

# Step 3: Build TypeScript packages
if [ "$SKIP_BUILD" = false ]; then
    print_header "Building TypeScript Packages"

    # Clean TypeScript build cache for proper rebuild
    log_info "Cleaning TypeScript build cache..."
    find packages -name "tsconfig.tsbuildinfo" -type f -delete 2>/dev/null || true
    find packages -name "dist" -type d -exec rm -rf {} + 2>/dev/null || true
    log_success "Build cache cleared"

    # Build all packages in correct order
    log_info "Building packages in dependency order..."

    # Phase 1: Core packages (no dependencies)
    log_info "Building core packages..."
    (cd packages/common && npm run build) || exit 1
    log_success "✓ @cmdb/common built"

    # Phase 2: Database package (depends on common)
    (cd packages/database && npm run build) || exit 1
    log_success "✓ @cmdb/database built"

    # Phase 3: Event packages (depends on common, database)
    (cd packages/event-processor && npm run build) || exit 1
    log_success "✓ @cmdb/event-processor built"

    (cd packages/event-streaming && npm run build) || exit 1
    log_success "✓ @cmdb/event-streaming built"

    # Phase 4: Integration framework packages (depends on common, database)
    (cd packages/integration-framework && npm run build) || exit 1
    log_success "✓ @cmdb/integration-framework built"

    (cd packages/data-mapper && npm run build) || exit 1
    log_success "✓ @cmdb/data-mapper built"

    (cd packages/identity-resolution && npm run build) || exit 1
    log_success "✓ @cmdb/identity-resolution built"

    (cd packages/integration-hub && npm run build) || exit 1
    log_success "✓ @cmdb/integration-hub built"

    # Phase 5: AI/ML Engine (depends on common, database, event-processor)
    (cd packages/ai-ml-engine && npm run build) || exit 1
    log_success "✓ @cmdb/ai-ml-engine built"

    # Phase 5.5: Unified Model and AI Discovery (needed by discovery-engine)
    (cd packages/unified-model && npm run build) || exit 1
    log_success "✓ @cmdb/unified-model built"

    (cd packages/ai-discovery && npm run build) || exit 1
    log_success "✓ @cmdb/ai-discovery built"

    # Phase 6: Discovery and ETL (needed by api-server)
    (cd packages/discovery-engine && npm run build) || exit 1
    log_success "✓ @cmdb/discovery-engine built"

    (cd packages/etl-processor && npm run build) || exit 1
    log_success "✓ @cmdb/etl-processor built"

    # Phase 6.5: ITIL, TBM, Framework Integration (optional packages)
    if [ -d "packages/itil-service-manager" ]; then
        if (cd packages/itil-service-manager && npm run build); then
            log_success "✓ @cmdb/itil-service-manager built"
        else
            log_warning "⚠ @cmdb/itil-service-manager build failed (optional)"
        fi
    fi

    if [ -d "packages/tbm-cost-engine" ]; then
        if (cd packages/tbm-cost-engine && npm run build); then
            log_success "✓ @cmdb/tbm-cost-engine built"
        else
            log_warning "⚠ @cmdb/tbm-cost-engine build failed (optional)"
        fi
    fi

    if [ -d "packages/framework-integration" ]; then
        if (cd packages/framework-integration && npm run build); then
            log_success "✓ @cmdb/framework-integration built"
        else
            log_warning "⚠ @cmdb/framework-integration build failed (optional)"
        fi
    fi

    # Phase 7: API Server (depends on everything)
    (cd packages/api-server && npm run build) || exit 1
    log_success "✓ @cmdb/api-server built"

    log_success "All packages built successfully"
else
    log_warning "Skipping TypeScript build (--skip-build flag)"
fi

# Verify dist folders exist for v2.0 packages
log_info "Verifying package builds..."
for pkg in common database event-processor integration-framework data-mapper identity-resolution integration-hub ai-ml-engine api-server; do
    if [ ! -d "packages/$pkg/dist" ]; then
        log_error "Missing dist folder for $pkg - build may have failed"
        exit 1
    fi
done
log_success "All required dist folders present"

# Step 4: Stop and remove existing containers
if [ "$PRESERVE_DATA" = false ]; then
    print_header "Cleaning Docker Environment"
    log_info "Stopping all containers..."
    docker-compose -f infrastructure/docker/docker-compose.yml down 2>/dev/null || true

    log_info "Removing old containers to force rebuild..."
    docker-compose -f infrastructure/docker/docker-compose.yml rm -f 2>/dev/null || true
else
    log_info "Removing only app containers..."
    docker rm -f cmdb-api-server cmdb-web-ui 2>/dev/null || true
fi

# Remove specific images to force rebuild (critical for code changes)
log_info "Removing old Docker images..."
docker rmi happycmdb-api-server happycmdb-web-ui 2>/dev/null || log_warning "Some images not found (OK if first deploy)"

log_success "Docker environment cleaned"

# Step 5: Build Docker images without cache
print_header "Building Docker Images (No Cache)"
log_info "Building API server image..."
docker-compose -f infrastructure/docker/docker-compose.yml build --no-cache api-server
if [ $? -ne 0 ]; then
    log_error "API server build failed"
    exit 1
fi
log_success "✓ API server image built"

log_info "Building Web UI image..."
docker-compose -f infrastructure/docker/docker-compose.yml build --no-cache web-ui
if [ $? -ne 0 ]; then
    log_error "Web UI build failed"
    exit 1
fi
log_success "✓ Web UI image built"

log_success "All Docker images built successfully"

# Step 6: Build and start documentation site
print_header "Building Documentation Site"
log_info "Building documentation site..."
(cd doc-site && npm run docs:build) 2>/dev/null || log_warning "Documentation build failed (non-critical)"

# Start documentation container
if [ -f "doc-site/docker-compose.yml" ]; then
    log_info "Starting documentation container..."
    (cd doc-site && docker-compose up -d) 2>/dev/null || log_warning "Documentation container failed to start (non-critical)"
    log_success "Documentation site started"
fi

# Step 7: Start infrastructure services
print_header "Starting Infrastructure Services"
docker-compose -f infrastructure/docker/docker-compose.yml up -d neo4j postgres redis zookeeper kafka
sleep 5

# Step 8: Wait for core infrastructure
log_info "Waiting for core infrastructure..."
check_health "neo4j" || exit 1
check_health "postgres" || exit 1
check_health "redis" || exit 1
check_health "zookeeper" || log_warning "Zookeeper health check failed, continuing..."
check_health "kafka" || log_warning "Kafka health check failed, continuing..."

# Step 9: Start application services
print_header "Starting Application Services"
docker-compose -f infrastructure/docker/docker-compose.yml up -d api-server web-ui
sleep 10

# Check API server health
log_info "Checking API server..."
if docker-compose -f infrastructure/docker/docker-compose.yml ps api-server | grep -q "Up"; then
    log_success "API server started"
else
    log_warning "API server may need more time to start"
fi

# Check Web UI
log_info "Checking Web UI..."
if docker-compose -f infrastructure/docker/docker-compose.yml ps web-ui | grep -q "Up"; then
    log_success "Web UI started"
else
    log_warning "Web UI may need more time to start"
fi

# Step 10: Seed database (optional)
if [ "$SEED_DATA" = true ]; then
    print_header "Seeding Database"
    log_info "Loading test data into Neo4j..."

    # Set environment variables for seed script (use .env if available)
    export NEO4J_URI="${NEO4J_URI:-bolt://localhost:7687}"
    export NEO4J_USERNAME="${NEO4J_USERNAME:-neo4j}"
    export NEO4J_PASSWORD="${NEO4J_PASSWORD:-cmdb_password_dev}"

    # Run seed script
    npx ts-node infrastructure/scripts/seed-data.ts

    if [ $? -eq 0 ]; then
        log_success "Database seeded successfully"
        echo ""
        echo "Test Credentials:"
        echo "  Email:    admin@happycmdb.local"
        echo "  Password: Admin123!"
        echo "  Role:     admin"
    else
        log_warning "Database seeding failed - you can run it manually with: npx ts-node infrastructure/scripts/seed-data.ts"
    fi
else
    log_info "Skipping database seeding (use --seed flag to enable)"
fi

# Step 10.5: Load connectors into database
print_header "Loading Built-in Connectors"
log_info "Registering connectors in PostgreSQL..."

# Wait for API server to be ready
sleep 5

# Set environment variables for connector loader (use .env if available)
export POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
export POSTGRES_PORT="${POSTGRES_PORT:-5433}"
export POSTGRES_DB="${POSTGRES_DB:-cmdb}"
export POSTGRES_USER="${POSTGRES_USER:-cmdb_user}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-cmdb_password_dev}"

# Run connector loader script
npx ts-node scripts/load-connectors.ts

if [ $? -eq 0 ]; then
    log_success "Built-in connectors loaded successfully"
    echo ""
    echo "17 Integration Connectors Registered:"
    echo "  • ServiceNow, Jira, SCCM, Intune, JAMF"
    echo "  • CrowdStrike, Defender, Datadog, Dynatrace"
    echo "  • AppDynamics, Tenable, Infoblox, Cisco Meraki"
    echo "  • Wiz, Veeam, Rubrik, Prometheus"
else
    log_warning "Connector loading failed - connectors will be loaded on API server startup"
    log_info "You can manually load connectors with: npx ts-node scripts/load-connectors.ts"
fi

# Step 11: Display summary
print_header "HappyCMDB v2.0 - Deployment Complete! 🎉"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  HappyCMDB Platform v2.0"
echo "  Enterprise Configuration Management Database"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📡 Service URLs:"
echo "  📚 Documentation:  http://localhost:8080"
echo "  🌐 Web UI:         http://localhost:3001"
echo "  🔌 REST API:       http://localhost:3000/api/v1"
echo "  ❤️  Health Check:  http://localhost:3000/api/v1/health"
echo "  🚀 GraphQL:        http://localhost:3000/graphql"
echo ""
echo "🗄️  Infrastructure:"
echo "  Neo4j Browser:     http://localhost:7474"
echo "  PostgreSQL:        localhost:5433"
echo "  Redis:             localhost:6379"
echo "  Apache Kafka:      localhost:9092"
echo "  Zookeeper:         localhost:2181"
echo ""
echo "🔐 Default Credentials:"
echo "  Neo4j:             neo4j / cmdb_password_dev"
echo "  PostgreSQL:        postgres / cmdb_password_dev"
if [ "$SEED_DATA" = true ]; then
    echo "  Admin User:        admin@happycmdb.local / Admin123!"
fi
echo ""
echo "🚀 v2.0 Features Deployed:"
echo "  ✓ 17 Integration Connectors (ServiceNow, Jira, etc.)"
echo "  ✓ 10 Discovery Workers (VMware, K8s, AD, etc.)"
echo "  ✓ Identity Resolution Engine"
echo "  ✓ Event Streaming (Kafka)"
echo "  ✓ AI/ML Engines (Anomaly, Impact, Drift)"
echo "  ✓ Advanced React UI Components"
echo "  ✓ Comprehensive API (18+ endpoints)"
echo ""
echo "📊 Container Status:"
docker-compose -f infrastructure/docker/docker-compose.yml ps
echo ""
echo "📝 Useful Commands:"
log_info "View logs:       docker-compose -f infrastructure/docker/docker-compose.yml logs -f [service-name]"
log_info "Restart service: docker stop cmdb-[service] && docker rm cmdb-[service] && docker-compose -f infrastructure/docker/docker-compose.yml up -d [service]"
log_info "Stop all:        docker-compose -f infrastructure/docker/docker-compose.yml down"
log_info "Clean all:       docker-compose -f infrastructure/docker/docker-compose.yml down -v"
log_info "Rebuild all:     ./deploy.sh --clean"
echo ""
log_success "Ready to use! Navigate to http://localhost:3001 to get started"
