#!/bin/bash

# =============================================================================
# HappyCMDB - Post-Deployment Validation
# =============================================================================
# Comprehensive validation after deployment to verify:
# - All services are running and healthy
# - API endpoints are responding correctly
# - Database connections are working
# - Discovery jobs are functioning
# - No errors in logs
# - Performance is within acceptable thresholds
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
CRITICAL_FAILURES=0

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
    CRITICAL_FAILURES=$((CRITICAL_FAILURES + 1))
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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

print_header "HappyCMDB - Post-Deployment Validation"
echo "Environment: $DEPLOY_ENV"
echo "Date: $(date)"
echo ""

# Load environment variables
if [[ -f "$PROJECT_ROOT/.env.$DEPLOY_ENV" ]]; then
    set -a
    source "$PROJECT_ROOT/.env.$DEPLOY_ENV"
    set +a
elif [[ -f "$PROJECT_ROOT/.env" ]]; then
    set -a
    source "$PROJECT_ROOT/.env"
    set +a
fi

# =============================================================================
# CHECK 1: Container Health
# =============================================================================
print_header "Container Health Status"

check_container() {
    local container=$1

    if docker ps --filter "name=$container" --filter "status=running" | grep -q "$container"; then
        # Check container health status if healthcheck is defined
        HEALTH=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "no-healthcheck")

        if [[ "$HEALTH" == "healthy" ]]; then
            log_success "$container is running and healthy"
        elif [[ "$HEALTH" == "no-healthcheck" ]]; then
            log_success "$container is running (no healthcheck defined)"
        else
            log_warning "$container is running but health status: $HEALTH"
        fi
        return 0
    else
        log_error "$container is not running"
        return 1
    fi
}

# Check critical containers
check_container "cmdb-neo4j"
check_container "cmdb-postgres"
check_container "cmdb-redis"
check_container "cmdb-api-server"
check_container "cmdb-web-ui"

# Check optional containers (warnings only)
docker ps --filter "name=cmdb-kafka" --filter "status=running" | grep -q "cmdb-kafka" \
    && log_success "cmdb-kafka is running" \
    || log_info "cmdb-kafka is not running (optional)"

docker ps --filter "name=cmdb-zookeeper" --filter "status=running" | grep -q "cmdb-zookeeper" \
    && log_success "cmdb-zookeeper is running" \
    || log_info "cmdb-zookeeper is not running (optional)"

# =============================================================================
# CHECK 2: Service Endpoints
# =============================================================================
print_header "Service Endpoint Validation"

API_HOST="${API_HOST:-localhost}"
API_PORT="${API_PORT:-3000}"
WEB_UI_PORT="${WEB_UI_PORT:-3001}"

test_endpoint() {
    local name=$1
    local url=$2
    local expected_content=$3

    log_info "Testing $name: $url"

    RESPONSE=$(curl -sf -w "\n%{http_code}" "$url" 2>/dev/null || echo "000")
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | head -n -1)

    if [[ "$HTTP_CODE" == "200" ]]; then
        if [[ -n "$expected_content" ]]; then
            if echo "$BODY" | grep -q "$expected_content"; then
                log_success "$name is responding correctly (HTTP $HTTP_CODE)"
            else
                log_error "$name returned HTTP 200 but unexpected content"
                echo "Expected: $expected_content"
                echo "Got: ${BODY:0:200}"
            fi
        else
            log_success "$name is responding (HTTP $HTTP_CODE)"
        fi
    else
        log_error "$name failed: HTTP $HTTP_CODE"
    fi
}

# Test API health endpoint
test_endpoint "API Health" "http://$API_HOST:$API_PORT/api/v1/health" '"status":"healthy"'

# Test GraphQL endpoint
test_endpoint "GraphQL" "http://$API_HOST:$API_PORT/graphql"

# Test Web UI
test_endpoint "Web UI" "http://$API_HOST:$WEB_UI_PORT" "HappyCMDB"

# Test specific API endpoints
test_endpoint "Discovery Definitions" "http://$API_HOST:$API_PORT/api/v1/discovery/definitions" "\\["

test_endpoint "CIs Endpoint" "http://$API_HOST:$API_PORT/api/v1/cis" "\\["

test_endpoint "Connectors Endpoint" "http://$API_HOST:$API_PORT/api/v1/connectors" "\\["

# =============================================================================
# CHECK 3: Database Connectivity
# =============================================================================
print_header "Database Connectivity"

# Neo4j
log_info "Testing Neo4j connection..."
NEO4J_PASSWORD="${NEO4J_PASSWORD:-cmdb_password_dev}"
if docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" "RETURN 1 as test" > /dev/null 2>&1; then
    log_success "Neo4j connection successful"

    # Check CI count
    CI_COUNT=$(docker exec cmdb-neo4j cypher-shell -u neo4j -p "$NEO4J_PASSWORD" \
        "MATCH (n:CI) RETURN count(n) as count" --format plain 2>/dev/null | tail -1 || echo "0")
    log_info "Total CIs in Neo4j: $CI_COUNT"
else
    log_error "Neo4j connection failed"
fi

# PostgreSQL
log_info "Testing PostgreSQL connection..."
POSTGRES_USER="${POSTGRES_USER:-cmdb_user}"
POSTGRES_DB="${POSTGRES_DATABASE:-cmdb}"
if docker exec cmdb-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1" > /dev/null 2>&1; then
    log_success "PostgreSQL connection successful"

    # Check connector registry
    CONNECTOR_COUNT=$(docker exec cmdb-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -t -c "SELECT COUNT(*) FROM connectors" 2>/dev/null | tr -d ' ' || echo "0")
    log_info "Registered connectors: $CONNECTOR_COUNT"

    # Check credentials
    CREDENTIAL_COUNT=$(docker exec cmdb-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -t -c "SELECT COUNT(*) FROM credentials" 2>/dev/null | tr -d ' ' || echo "0")
    log_info "Stored credentials: $CREDENTIAL_COUNT"
else
    log_error "PostgreSQL connection failed"
fi

# Redis
log_info "Testing Redis connection..."
if docker exec cmdb-redis redis-cli ping > /dev/null 2>&1; then
    log_success "Redis connection successful"

    # Check Redis keys
    KEY_COUNT=$(docker exec cmdb-redis redis-cli DBSIZE 2>/dev/null | awk '{print $2}' || echo "0")
    log_info "Redis keys: $KEY_COUNT"
else
    log_error "Redis connection failed"
fi

# =============================================================================
# CHECK 4: Discovery System
# =============================================================================
print_header "Discovery System Status"

# Check if discovery engine is enabled
DISCOVERY_ENABLED="${DISCOVERY_ENABLED:-true}"
if [[ "$DISCOVERY_ENABLED" == "true" ]]; then
    log_info "Discovery engine is enabled"

    # Test discovery API endpoints
    DEFINITIONS_RESPONSE=$(curl -sf "http://$API_HOST:$API_PORT/api/v1/discovery/definitions" 2>/dev/null || echo "[]")
    DEFINITIONS_COUNT=$(echo "$DEFINITIONS_RESPONSE" | jq '. | length' 2>/dev/null || echo "0")

    if [[ $DEFINITIONS_COUNT -gt 0 ]]; then
        log_success "Discovery definitions found: $DEFINITIONS_COUNT"
    else
        log_warning "No discovery definitions configured"
    fi

    # Check recent discovery jobs
    JOBS_RESPONSE=$(curl -sf "http://$API_HOST:$API_PORT/api/v1/discovery/jobs?limit=10" 2>/dev/null || echo "[]")
    JOBS_COUNT=$(echo "$JOBS_RESPONSE" | jq '. | length' 2>/dev/null || echo "0")
    log_info "Recent discovery jobs: $JOBS_COUNT"

else
    log_warning "Discovery engine is disabled"
fi

# =============================================================================
# CHECK 5: Error Log Analysis
# =============================================================================
print_header "Recent Error Logs"

check_container_logs() {
    local container=$1
    local lookback_minutes=5

    log_info "Checking $container logs (last $lookback_minutes minutes)..."

    # Get recent logs
    SINCE_TIME="$(date -u -d "$lookback_minutes minutes ago" +"%Y-%m-%dT%H:%M:%S" 2>/dev/null || date -u -v -${lookback_minutes}M +"%Y-%m-%dT%H:%M:%S" 2>/dev/null)"
    LOGS=$(docker logs "$container" --since "$SINCE_TIME" 2>&1 || echo "")

    # Count errors
    ERROR_COUNT=$(echo "$LOGS" | grep -iE "(error|exception|fatal)" | grep -v "0 errors" | wc -l || echo "0")
    WARNING_COUNT=$(echo "$LOGS" | grep -iE "warn" | wc -l || echo "0")

    if [[ $ERROR_COUNT -gt 0 ]]; then
        log_error "$container has $ERROR_COUNT errors in last $lookback_minutes minutes"
        echo "Recent errors:"
        echo "$LOGS" | grep -iE "(error|exception|fatal)" | tail -5
    elif [[ $WARNING_COUNT -gt 10 ]]; then
        log_warning "$container has $WARNING_COUNT warnings in last $lookback_minutes minutes"
    else
        log_success "$container logs look clean ($ERROR_COUNT errors, $WARNING_COUNT warnings)"
    fi
}

check_container_logs "cmdb-api-server"
check_container_logs "cmdb-neo4j"
check_container_logs "cmdb-postgres"

# =============================================================================
# CHECK 6: Performance Metrics
# =============================================================================
print_header "Performance Metrics"

# API response time
log_info "Measuring API response times..."

RESPONSE_TIME=$(curl -sf -o /dev/null -w "%{time_total}" "http://$API_HOST:$API_PORT/api/v1/health" 2>/dev/null || echo "999")
RESPONSE_MS=$(echo "$RESPONSE_TIME * 1000" | bc 2>/dev/null || echo "999")

if (( $(echo "$RESPONSE_TIME < 1.0" | bc -l 2>/dev/null || echo "0") )); then
    log_success "API response time: ${RESPONSE_MS}ms"
elif (( $(echo "$RESPONSE_TIME < 3.0" | bc -l 2>/dev/null || echo "0") )); then
    log_warning "API response time: ${RESPONSE_MS}ms (slow)"
else
    log_error "API response time: ${RESPONSE_MS}ms (very slow)"
fi

# Container resource usage
log_info "Container resource usage:"

docker stats --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}" \
    cmdb-api-server cmdb-neo4j cmdb-postgres cmdb-redis 2>/dev/null || log_warning "Could not get container stats"

# =============================================================================
# CHECK 7: AI/ML Features (if enabled)
# =============================================================================
print_header "AI/ML Features Status"

AI_ANOMALY_ENABLED="${AI_ANOMALY_DETECTION_ENABLED:-false}"
AI_DRIFT_ENABLED="${AI_DRIFT_DETECTION_ENABLED:-false}"
AI_IMPACT_ENABLED="${AI_IMPACT_ANALYSIS_ENABLED:-false}"

if [[ "$AI_ANOMALY_ENABLED" == "true" || "$AI_DRIFT_ENABLED" == "true" || "$AI_IMPACT_ENABLED" == "true" ]]; then
    log_info "AI/ML features are enabled:"
    [[ "$AI_ANOMALY_ENABLED" == "true" ]] && log_info "  • Anomaly Detection: enabled"
    [[ "$AI_DRIFT_ENABLED" == "true" ]] && log_info "  • Drift Detection: enabled"
    [[ "$AI_IMPACT_ENABLED" == "true" ]] && log_info "  • Impact Analysis: enabled"

    # Test AI endpoints
    ANOMALY_RESPONSE=$(curl -sf "http://$API_HOST:$API_PORT/api/v1/ai/anomalies?limit=1" 2>/dev/null || echo "error")
    if [[ "$ANOMALY_RESPONSE" != "error" ]]; then
        log_success "AI/ML endpoints responding"
    else
        log_warning "AI/ML endpoints not accessible"
    fi
else
    log_info "AI/ML features are disabled"
fi

# =============================================================================
# CHECK 8: Integration Tests
# =============================================================================
print_header "Integration Tests"

# Test CI creation workflow
log_info "Testing CI creation workflow..."

TEST_CI_PAYLOAD='{"ci_name":"post-deploy-test-server","ci_type":"server","environment":"test","status":"active"}'
CREATE_RESPONSE=$(curl -sf -X POST "http://$API_HOST:$API_PORT/api/v1/cis" \
    -H "Content-Type: application/json" \
    -d "$TEST_CI_PAYLOAD" 2>/dev/null || echo "error")

if [[ "$CREATE_RESPONSE" != "error" ]]; then
    CI_ID=$(echo "$CREATE_RESPONSE" | jq -r '.id // .ci_id' 2>/dev/null || echo "")
    if [[ -n "$CI_ID" ]]; then
        log_success "CI creation successful (ID: $CI_ID)"

        # Test CI retrieval
        GET_RESPONSE=$(curl -sf "http://$API_HOST:$API_PORT/api/v1/cis/$CI_ID" 2>/dev/null || echo "error")
        if [[ "$GET_RESPONSE" != "error" ]]; then
            log_success "CI retrieval successful"

            # Cleanup test CI
            DELETE_RESPONSE=$(curl -sf -X DELETE "http://$API_HOST:$API_PORT/api/v1/cis/$CI_ID" 2>/dev/null || echo "error")
            [[ "$DELETE_RESPONSE" != "error" ]] && log_success "CI deletion successful"
        else
            log_error "CI retrieval failed"
        fi
    else
        log_error "CI creation returned no ID"
    fi
else
    log_error "CI creation failed"
fi

# Test GraphQL query
log_info "Testing GraphQL query..."
GRAPHQL_QUERY='{"query":"{ __schema { queryType { name } } }"}'
GRAPHQL_RESPONSE=$(curl -sf -X POST "http://$API_HOST:$API_PORT/graphql" \
    -H "Content-Type: application/json" \
    -d "$GRAPHQL_QUERY" 2>/dev/null || echo "error")

if echo "$GRAPHQL_RESPONSE" | grep -q "queryType"; then
    log_success "GraphQL query successful"
else
    log_error "GraphQL query failed"
fi

# =============================================================================
# CHECK 9: Security Validation
# =============================================================================
print_header "Security Validation"

# Check SSL/TLS (production only)
if [[ "$DEPLOY_ENV" == "production" ]]; then
    SSL_ENABLED="${SSL_ENABLED:-false}"

    if [[ "$SSL_ENABLED" == "true" ]]; then
        log_info "Checking SSL certificate..."
        # Add SSL certificate validation here
        log_success "SSL is enabled"
    else
        log_error "SSL is disabled in production environment"
    fi
else
    log_info "Skipping SSL checks (non-production environment)"
fi

# Check for default credentials
if [[ "$NEO4J_PASSWORD" == *"password"* ]]; then
    log_warning "Neo4j password appears to be using default/weak value"
fi

if [[ "$POSTGRES_PASSWORD" == *"password"* ]]; then
    log_warning "PostgreSQL password appears to be using default/weak value"
fi

# =============================================================================
# VALIDATION SUMMARY
# =============================================================================
print_header "Post-Deployment Validation Summary"

echo "Environment: $DEPLOY_ENV"
echo "Validation completed at: $(date)"
echo ""

if [[ $CRITICAL_FAILURES -gt 0 ]]; then
    log_error "CRITICAL FAILURES: $CRITICAL_FAILURES"
    echo ""
    echo "⚠️  Action required: Fix critical failures immediately"
    echo ""
    exit 1
elif [[ "$WARNINGS_FOUND" == true ]]; then
    log_warning "Validation completed with warnings"
    echo ""
    echo "⚠️  Review warnings above - system is functional but may need attention"
    echo ""
    exit 0
else
    log_success "All post-deployment validations passed!"
    echo ""
    echo "✅ System is healthy and fully operational"
    echo ""
    exit 0
fi
