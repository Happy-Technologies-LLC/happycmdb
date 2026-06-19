#!/bin/bash

# =============================================================================
# HappyCMDB - Pre-Deployment Validation Checklist
# =============================================================================
# Automated checks to verify system is ready for deployment
# Run this before any staging or production deployment
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Track overall status
VALIDATION_PASSED=true
WARNINGS_FOUND=false

# Functions
log_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
    WARNINGS_FOUND=true
}

log_error() {
    echo -e "${RED}✗${NC} $1"
    VALIDATION_PASSED=false
}

print_header() {
    echo ""
    echo "==========================================="
    echo "$1"
    echo "==========================================="
    echo ""
}

# Parse environment (staging or production)
DEPLOY_ENV="${1:-staging}"

print_header "HappyCMDB - Pre-Deployment Validation"
echo "Environment: $DEPLOY_ENV"
echo "Date: $(date)"
echo ""

# =============================================================================
# CHECK 1: Git Repository Status
# =============================================================================
print_header "Git Repository Status"

# Check for uncommitted changes
if [[ -n $(git status -s) ]]; then
    log_error "Uncommitted changes detected - commit or stash before deploying"
    git status -s
else
    log_success "No uncommitted changes"
fi

# Check current branch
CURRENT_BRANCH=$(git branch --show-current)
if [[ "$DEPLOY_ENV" == "production" ]]; then
    if [[ "$CURRENT_BRANCH" != "main" && "$CURRENT_BRANCH" != "master" ]]; then
        log_error "Production must deploy from main/master branch (current: $CURRENT_BRANCH)"
    else
        log_success "On production branch: $CURRENT_BRANCH"
    fi
elif [[ "$DEPLOY_ENV" == "staging" ]]; then
    if [[ "$CURRENT_BRANCH" != "develop" && "$CURRENT_BRANCH" != "staging" ]]; then
        log_warning "Staging typically deploys from develop/staging branch (current: $CURRENT_BRANCH)"
    else
        log_success "On staging branch: $CURRENT_BRANCH"
    fi
fi

# Check if branch is up to date with remote
git fetch origin $CURRENT_BRANCH 2>/dev/null || true
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse @{u} 2>/dev/null || echo "")
if [[ -z "$REMOTE" ]]; then
    log_warning "No upstream branch configured"
elif [[ "$LOCAL" != "$REMOTE" ]]; then
    log_error "Branch is not up to date with remote - pull latest changes"
else
    log_success "Branch is up to date with remote"
fi

# =============================================================================
# CHECK 2: Test Suite
# =============================================================================
print_header "Test Suite Validation"

# Check if tests exist
if [[ ! -d "packages/api-server/__tests__" ]]; then
    log_warning "Test directory not found - tests may not be configured"
else
    log_info "Running test suite..."

    # Run tests with timeout
    timeout 300 npm test -- --passWithNoTests 2>&1 | tee /tmp/test-output.log
    TEST_EXIT_CODE=${PIPESTATUS[0]}

    if [[ $TEST_EXIT_CODE -eq 0 ]]; then
        log_success "All tests passed"
    elif [[ $TEST_EXIT_CODE -eq 124 ]]; then
        log_error "Tests timed out after 5 minutes"
    else
        log_error "Test failures detected - fix before deploying"
        # Show failed tests
        grep -E "(FAIL|Error)" /tmp/test-output.log | head -20 || true
    fi
fi

# =============================================================================
# CHECK 3: Database Backups
# =============================================================================
print_header "Database Backup Status"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/happycmdb}"

# Check if backup directory exists
if [[ ! -d "$BACKUP_DIR" ]]; then
    log_warning "Backup directory does not exist: $BACKUP_DIR"
else
    # Find most recent Neo4j backup
    LATEST_NEO4J=$(find "$BACKUP_DIR" -name "neo4j-backup-*.tar.gz" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
    if [[ -z "$LATEST_NEO4J" ]]; then
        log_warning "No Neo4j backups found in $BACKUP_DIR"
    else
        BACKUP_AGE=$(( ($(date +%s) - $(stat -f %m "$LATEST_NEO4J" 2>/dev/null || stat -c %Y "$LATEST_NEO4J" 2>/dev/null)) / 3600 ))
        if [[ $BACKUP_AGE -gt 24 ]]; then
            log_error "Latest Neo4j backup is $BACKUP_AGE hours old (>24h) - create fresh backup"
        else
            log_success "Neo4j backup is recent ($BACKUP_AGE hours old)"
        fi
    fi

    # Find most recent PostgreSQL backup
    LATEST_POSTGRES=$(find "$BACKUP_DIR" -name "postgres-backup-*.sql.gz" -type f -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)
    if [[ -z "$LATEST_POSTGRES" ]]; then
        log_warning "No PostgreSQL backups found in $BACKUP_DIR"
    else
        BACKUP_AGE=$(( ($(date +%s) - $(stat -f %m "$LATEST_POSTGRES" 2>/dev/null || stat -c %Y "$LATEST_POSTGRES" 2>/dev/null)) / 3600 ))
        if [[ $BACKUP_AGE -gt 24 ]]; then
            log_error "Latest PostgreSQL backup is $BACKUP_AGE hours old (>24h) - create fresh backup"
        else
            log_success "PostgreSQL backup is recent ($BACKUP_AGE hours old)"
        fi
    fi
fi

# =============================================================================
# CHECK 4: Environment Configuration
# =============================================================================
print_header "Environment Configuration"

# Check .env file exists
if [[ ! -f ".env" ]]; then
    log_error ".env file missing - copy from .env.example and configure"
else
    log_success ".env file exists"

    # Source .env
    set -a
    source .env
    set +a

    # Check critical secrets are not default values
    if [[ "$JWT_SECRET" == *"change-this"* ]]; then
        log_error "JWT_SECRET still using default value - set secure secret"
    else
        log_success "JWT_SECRET is configured"
    fi

    if [[ "$ENCRYPTION_KEY" == *"change-this"* ]]; then
        log_error "ENCRYPTION_KEY still using default value - set secure key"
    else
        log_success "ENCRYPTION_KEY is configured"
    fi

    # Check production-specific settings
    if [[ "$DEPLOY_ENV" == "production" ]]; then
        if [[ "$NODE_ENV" != "production" ]]; then
            log_error "NODE_ENV must be 'production' for production deployment (current: $NODE_ENV)"
        else
            log_success "NODE_ENV is set to production"
        fi

        if [[ "$LOG_LEVEL" != "warn" && "$LOG_LEVEL" != "error" ]]; then
            log_warning "LOG_LEVEL should be 'warn' or 'error' in production (current: $LOG_LEVEL)"
        else
            log_success "LOG_LEVEL is appropriate for production"
        fi
    fi

    # Check database credentials are set
    if [[ -z "$NEO4J_PASSWORD" ]] || [[ "$NEO4J_PASSWORD" == "your-neo4j-password" ]]; then
        log_error "NEO4J_PASSWORD not configured"
    else
        log_success "Neo4j credentials configured"
    fi

    if [[ -z "$POSTGRES_PASSWORD" ]] || [[ "$POSTGRES_PASSWORD" == "your-postgres-password" ]]; then
        log_error "POSTGRES_PASSWORD not configured"
    else
        log_success "PostgreSQL credentials configured"
    fi
fi

# =============================================================================
# CHECK 5: SSL Certificates
# =============================================================================
print_header "SSL Certificate Status"

if [[ "$DEPLOY_ENV" == "production" ]]; then
    # Load SSL settings
    SSL_ENABLED="${SSL_ENABLED:-false}"
    NGINX_SSL_CERT_PATH="${NGINX_SSL_CERT_PATH:-}"

    if [[ "$SSL_ENABLED" == "true" ]]; then
        # Check certificate files exist
        if [[ ! -f "$NGINX_SSL_CERT_PATH" ]]; then
            log_error "SSL certificate not found: $NGINX_SSL_CERT_PATH"
        else
            # Check certificate expiration
            CERT_EXPIRY=$(openssl x509 -enddate -noout -in "$NGINX_SSL_CERT_PATH" 2>/dev/null | cut -d= -f2)
            if [[ -n "$CERT_EXPIRY" ]]; then
                EXPIRY_EPOCH=$(date -d "$CERT_EXPIRY" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$CERT_EXPIRY" +%s 2>/dev/null)
                NOW_EPOCH=$(date +%s)
                DAYS_UNTIL_EXPIRY=$(( ($EXPIRY_EPOCH - $NOW_EPOCH) / 86400 ))

                if [[ $DAYS_UNTIL_EXPIRY -lt 30 ]]; then
                    log_error "SSL certificate expires in $DAYS_UNTIL_EXPIRY days - renew immediately"
                elif [[ $DAYS_UNTIL_EXPIRY -lt 90 ]]; then
                    log_warning "SSL certificate expires in $DAYS_UNTIL_EXPIRY days - consider renewal"
                else
                    log_success "SSL certificate valid for $DAYS_UNTIL_EXPIRY days"
                fi
            else
                log_warning "Could not parse certificate expiration date"
            fi
        fi
    else
        log_warning "SSL is disabled - production should use SSL"
    fi
else
    log_info "Skipping SSL checks for non-production environment"
fi

# =============================================================================
# CHECK 6: Disk Space
# =============================================================================
print_header "Disk Space Availability"

# Check disk usage on root partition
DISK_USAGE=$(df -h / | tail -1 | awk '{print $5}' | sed 's/%//')
if [[ $DISK_USAGE -gt 80 ]]; then
    log_error "Disk usage is $DISK_USAGE% - free up space before deploying (>80%)"
elif [[ $DISK_USAGE -gt 70 ]]; then
    log_warning "Disk usage is $DISK_USAGE% - consider freeing space"
else
    log_success "Disk usage is $DISK_USAGE% (sufficient)"
fi

# Check specific directories
if [[ -d "/var/lib/docker" ]]; then
    DOCKER_SIZE=$(du -sh /var/lib/docker 2>/dev/null | awk '{print $1}' || echo "unknown")
    log_info "Docker data size: $DOCKER_SIZE"
fi

if [[ -d "$BACKUP_DIR" ]]; then
    BACKUP_SIZE=$(du -sh "$BACKUP_DIR" 2>/dev/null | awk '{print $1}' || echo "unknown")
    log_info "Backup data size: $BACKUP_SIZE"
fi

# =============================================================================
# CHECK 7: Dependencies
# =============================================================================
print_header "Dependency Status"

# Check for outdated dependencies
log_info "Checking for outdated dependencies..."
npm outdated > /tmp/npm-outdated.log 2>&1 || true

if [[ -s /tmp/npm-outdated.log ]]; then
    CRITICAL_OUTDATED=$(grep -E "(Major|Critical)" /tmp/npm-outdated.log | wc -l || echo 0)
    if [[ $CRITICAL_OUTDATED -gt 0 ]]; then
        log_warning "$CRITICAL_OUTDATED critical dependencies are outdated"
        head -10 /tmp/npm-outdated.log
    else
        log_success "No critical dependency updates needed"
    fi
else
    log_success "All dependencies are up to date"
fi

# Check for security vulnerabilities
log_info "Running security audit..."
npm audit --production --audit-level=moderate > /tmp/npm-audit.log 2>&1 || true

if grep -q "vulnerabilities" /tmp/npm-audit.log; then
    CRITICAL_VULNS=$(grep -o "[0-9]* critical" /tmp/npm-audit.log | awk '{print $1}' || echo 0)
    HIGH_VULNS=$(grep -o "[0-9]* high" /tmp/npm-audit.log | awk '{print $1}' || echo 0)

    if [[ $CRITICAL_VULNS -gt 0 ]]; then
        log_error "$CRITICAL_VULNS critical vulnerabilities found - fix before deploying"
        npm audit --production | head -30
    elif [[ $HIGH_VULNS -gt 0 ]]; then
        log_warning "$HIGH_VULNS high vulnerabilities found - consider fixing"
    else
        log_success "No critical vulnerabilities found"
    fi
else
    log_success "No security vulnerabilities detected"
fi

# =============================================================================
# CHECK 8: Docker Environment
# =============================================================================
print_header "Docker Environment"

# Check Docker is running
if ! docker info > /dev/null 2>&1; then
    log_error "Docker daemon is not running"
else
    log_success "Docker daemon is running"

    # Check Docker Compose is available
    if ! docker-compose version > /dev/null 2>&1; then
        log_error "docker-compose is not installed or not in PATH"
    else
        COMPOSE_VERSION=$(docker-compose version --short)
        log_success "docker-compose is available ($COMPOSE_VERSION)"
    fi

    # Check Docker disk space
    DOCKER_DISK=$(docker system df --format "{{.Type}}\t{{.Size}}" 2>/dev/null || echo "")
    if [[ -n "$DOCKER_DISK" ]]; then
        log_info "Docker disk usage:"
        echo "$DOCKER_DISK" | while read -r line; do
            echo "  $line"
        done
    fi
fi

# =============================================================================
# CHECK 9: Build Artifacts
# =============================================================================
print_header "Build Artifacts"

# Check that all packages have dist folders
MISSING_DIST=()
for pkg in common database event-processor integration-framework data-mapper identity-resolution integration-hub ai-ml-engine api-server discovery-engine etl-processor; do
    if [[ ! -d "packages/$pkg/dist" ]]; then
        MISSING_DIST+=("$pkg")
    fi
done

if [[ ${#MISSING_DIST[@]} -gt 0 ]]; then
    log_error "Missing dist folders for: ${MISSING_DIST[*]} - run 'npm run build' first"
else
    log_success "All packages have build artifacts"
fi

# Check web UI build
if [[ ! -d "web-ui/build" && ! -d "web-ui/dist" ]]; then
    log_warning "Web UI build folder not found - may need to build UI"
else
    log_success "Web UI build artifacts present"
fi

# =============================================================================
# CHECK 10: Network Connectivity
# =============================================================================
print_header "Network Connectivity"

# Check internet connectivity (for pulling Docker images)
if ping -c 1 8.8.8.8 > /dev/null 2>&1; then
    log_success "Internet connectivity available"
else
    log_warning "No internet connectivity - ensure Docker images are cached locally"
fi

# Check DNS resolution
if nslookup docker.io > /dev/null 2>&1; then
    log_success "DNS resolution working"
else
    log_warning "DNS resolution issues detected"
fi

# =============================================================================
# SUMMARY
# =============================================================================
print_header "Validation Summary"

if [[ "$VALIDATION_PASSED" == true ]]; then
    if [[ "$WARNINGS_FOUND" == true ]]; then
        log_warning "Pre-deployment validation passed with warnings"
        echo ""
        echo "Review warnings above before proceeding with deployment."
        echo ""
        exit 0
    else
        log_success "All pre-deployment checks passed!"
        echo ""
        echo "System is ready for deployment to $DEPLOY_ENV."
        echo ""
        exit 0
    fi
else
    log_error "Pre-deployment validation FAILED"
    echo ""
    echo "Fix the errors above before deploying to $DEPLOY_ENV."
    echo ""
    exit 1
fi
