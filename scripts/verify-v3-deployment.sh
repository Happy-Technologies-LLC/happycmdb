#!/bin/bash

# =============================================================================
# HappyCMDB v3.0 - Deployment Verification Script
# =============================================================================
# This script verifies that all v3.0 services are running and healthy
# Run after: ./deploy.sh
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
TOTAL_CHECKS=0
PASSED_CHECKS=0
FAILED_CHECKS=0

# Helper functions
print_header() {
    echo -e "\n${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}\n"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
    ((PASSED_CHECKS++))
    ((TOTAL_CHECKS++))
}

print_failure() {
    echo -e "${RED}✗${NC} $1"
    ((FAILED_CHECKS++))
    ((TOTAL_CHECKS++))
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

check_service() {
    local service_name=$1
    local container_name=$2

    if docker ps --format '{{.Names}}' | grep -q "^${container_name}$"; then
        # Check if container is healthy (if health check is defined)
        local health_status=$(docker inspect --format='{{.State.Health.Status}}' ${container_name} 2>/dev/null || echo "none")

        if [ "$health_status" = "healthy" ]; then
            print_success "${service_name} is running and healthy"
            return 0
        elif [ "$health_status" = "none" ]; then
            # No health check defined, just check if running
            print_success "${service_name} is running (no health check defined)"
            return 0
        else
            print_failure "${service_name} is running but unhealthy (status: ${health_status})"
            return 1
        fi
    else
        print_failure "${service_name} is not running"
        return 1
    fi
}

check_http_endpoint() {
    local name=$1
    local url=$2
    local expected_status=${3:-200}

    local response=$(curl -s -o /dev/null -w "%{http_code}" ${url} 2>/dev/null || echo "000")

    if [ "$response" = "$expected_status" ]; then
        print_success "${name} endpoint responding (HTTP ${response})"
        return 0
    else
        print_failure "${name} endpoint not responding (HTTP ${response}, expected ${expected_status})"
        return 1
    fi
}

check_port() {
    local name=$1
    local host=$2
    local port=$3

    if nc -z -w 3 ${host} ${port} 2>/dev/null; then
        print_success "${name} port ${port} is open"
        return 0
    else
        print_failure "${name} port ${port} is not accessible"
        return 1
    fi
}

# =============================================================================
# Main Verification Checks
# =============================================================================

print_header "HappyCMDB v3.0 Deployment Verification"

echo "Starting comprehensive health checks..."
echo "Timestamp: $(date)"
echo ""

# -----------------------------------------------------------------------------
# 1. Docker Services Check
# -----------------------------------------------------------------------------
print_header "1. Docker Container Status"

check_service "Neo4j Graph Database" "cmdb-neo4j"
check_service "PostgreSQL Database" "cmdb-postgres"
check_service "Redis Cache" "cmdb-redis"
check_service "Zookeeper" "cmdb-zookeeper"
check_service "Kafka Event Stream" "cmdb-kafka"
check_service "Kafka UI" "cmdb-kafka-ui"
check_service "API Server" "cmdb-api-server"
check_service "Web UI" "cmdb-web-ui"
check_service "Grafana Dashboards" "cmdb-grafana"
check_service "Metabase Analytics" "cmdb-metabase"

# -----------------------------------------------------------------------------
# 2. Network Connectivity Check
# -----------------------------------------------------------------------------
print_header "2. Network Port Connectivity"

check_port "Neo4j Bolt" "localhost" 7687
check_port "Neo4j HTTP" "localhost" 7474
check_port "PostgreSQL" "localhost" 5433
check_port "Redis" "localhost" 6379
check_port "Kafka" "localhost" 9092
check_port "Kafka UI" "localhost" 8090
check_port "API Server" "localhost" 3000
check_port "Web UI (HTTP)" "localhost" 80
check_port "Grafana" "localhost" 3001
check_port "Metabase" "localhost" 3002

# -----------------------------------------------------------------------------
# 3. API Health Endpoints
# -----------------------------------------------------------------------------
print_header "3. API Health Endpoints"

check_http_endpoint "API Server Health" "http://localhost:3000/api/v1/cmdb-health"
check_http_endpoint "Web UI Health" "http://localhost/health"
check_http_endpoint "Grafana Health" "http://localhost:3001/api/health"
check_http_endpoint "Metabase Health" "http://localhost:3002/api/health"
check_http_endpoint "Kafka UI Health" "http://localhost:8090/actuator/health"

# -----------------------------------------------------------------------------
# 4. v3.0 Specific Features
# -----------------------------------------------------------------------------
print_header "4. v3.0 Feature Availability"

# Check AI/ML endpoints
if curl -s -f -X GET "http://localhost:3000/api/v1/ai/status" >/dev/null 2>&1; then
    print_success "AI/ML Engine API available"
else
    print_warning "AI/ML Engine API endpoint not found (may require authentication)"
fi

# Check BSM Impact Analysis endpoints
if curl -s -f -X GET "http://localhost:3000/api/v1/bsm/health" >/dev/null 2>&1; then
    print_success "BSM Impact Engine API available"
else
    print_warning "BSM Impact Engine API endpoint not found (may require authentication)"
fi

# Check TBM Cost Management endpoints
if curl -s -f -X GET "http://localhost:3000/api/v1/tbm/health" >/dev/null 2>&1; then
    print_success "TBM Cost Engine API available"
else
    print_warning "TBM Cost Engine API endpoint not found (may require authentication)"
fi

# Check Event Streaming
if curl -s -f -X GET "http://localhost:3000/api/v1/events/health" >/dev/null 2>&1; then
    print_success "Event Streaming API available"
else
    print_warning "Event Streaming API endpoint not found (may require authentication)"
fi

# -----------------------------------------------------------------------------
# 5. Database Connectivity
# -----------------------------------------------------------------------------
print_header "5. Database Connectivity"

# Neo4j connectivity check
if docker exec cmdb-neo4j cypher-shell -u neo4j -p "${NEO4J_PASSWORD:-your-neo4j-password}" "RETURN 1" >/dev/null 2>&1; then
    print_success "Neo4j database is accessible"
else
    print_failure "Neo4j database connection failed"
fi

# PostgreSQL connectivity check
if docker exec cmdb-postgres pg_isready -U cmdb_user -d cmdb >/dev/null 2>&1; then
    print_success "PostgreSQL database is accessible"
else
    print_failure "PostgreSQL database connection failed"
fi

# Redis connectivity check
if docker exec cmdb-redis redis-cli ping | grep -q PONG; then
    print_success "Redis cache is accessible"
else
    print_failure "Redis cache connection failed"
fi

# -----------------------------------------------------------------------------
# 6. Kafka Topics Check
# -----------------------------------------------------------------------------
print_header "6. Event Streaming Topics"

# Check if Kafka topics exist
KAFKA_TOPICS=$(docker exec cmdb-kafka kafka-topics --bootstrap-server localhost:9092 --list 2>/dev/null || echo "")

if echo "$KAFKA_TOPICS" | grep -q "ci.discovered"; then
    print_success "ci.discovered topic exists"
else
    print_warning "ci.discovered topic not found (will be auto-created on first use)"
fi

if echo "$KAFKA_TOPICS" | grep -q "ci.changed"; then
    print_success "ci.changed topic exists"
else
    print_warning "ci.changed topic not found (will be auto-created on first use)"
fi

if echo "$KAFKA_TOPICS" | grep -q "relationship.created"; then
    print_success "relationship.created topic exists"
else
    print_warning "relationship.created topic not found (will be auto-created on first use)"
fi

# -----------------------------------------------------------------------------
# 7. Dashboard Accessibility
# -----------------------------------------------------------------------------
print_header "7. Dashboard Accessibility"

# Grafana
if curl -s "http://localhost:3001/login" | grep -q "Grafana"; then
    print_success "Grafana dashboard is accessible"
else
    print_failure "Grafana dashboard is not accessible"
fi

# Metabase
if curl -s "http://localhost:3002/" | grep -q "Metabase"; then
    print_success "Metabase dashboard is accessible"
else
    print_warning "Metabase may still be initializing (first startup takes 30-60 seconds)"
fi

# Kafka UI
if curl -s "http://localhost:8090/" | grep -q "Kafka"; then
    print_success "Kafka UI dashboard is accessible"
else
    print_failure "Kafka UI dashboard is not accessible"
fi

# -----------------------------------------------------------------------------
# 8. Docker Volume Status
# -----------------------------------------------------------------------------
print_header "8. Persistent Storage Volumes"

for volume in neo4j_data postgres_data redis_data kafka_data zookeeper_data grafana_data metabase_data; do
    if docker volume ls | grep -q "${volume}"; then
        print_success "Volume ${volume} exists"
    else
        print_failure "Volume ${volume} is missing"
    fi
done

# -----------------------------------------------------------------------------
# Summary Report
# -----------------------------------------------------------------------------
print_header "Verification Summary"

echo -e "Total Checks: ${TOTAL_CHECKS}"
echo -e "${GREEN}Passed: ${PASSED_CHECKS}${NC}"
echo -e "${RED}Failed: ${FAILED_CHECKS}${NC}"
echo ""

# Calculate success percentage
SUCCESS_RATE=$((PASSED_CHECKS * 100 / TOTAL_CHECKS))

if [ $FAILED_CHECKS -eq 0 ]; then
    echo -e "${GREEN}✓ All checks passed! HappyCMDB v3.0 is fully operational.${NC}"
    echo ""
    echo "Access Points:"
    echo "  - Web UI:     http://localhost"
    echo "  - API:        http://localhost:3000"
    echo "  - Grafana:    http://localhost:3001 (admin/your-grafana-admin-password)"
    echo "  - Metabase:   http://localhost:3002 (configure on first access)"
    echo "  - Kafka UI:   http://localhost:8090"
    echo "  - Neo4j:      http://localhost:7474 (neo4j/your-neo4j-password)"
    echo ""
    exit 0
elif [ $SUCCESS_RATE -ge 80 ]; then
    echo -e "${YELLOW}⚠ Deployment is ${SUCCESS_RATE}% operational with some warnings.${NC}"
    echo "Check failed items above and review logs:"
    echo "  docker-compose -f infrastructure/docker/docker-compose.yml logs <service-name>"
    echo ""
    exit 1
else
    echo -e "${RED}✗ Deployment has critical issues (${SUCCESS_RATE}% success rate).${NC}"
    echo "Review container logs for details:"
    echo "  docker-compose -f infrastructure/docker/docker-compose.yml logs"
    echo ""
    exit 2
fi
