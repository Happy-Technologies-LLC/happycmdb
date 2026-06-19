#!/bin/bash

# HappyCMDB Load Testing Runner
# Executes load tests with proper setup and teardown

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPORTS_DIR="${SCRIPT_DIR}/reports"
DATA_DIR="${SCRIPT_DIR}/data"
SCRIPTS_DIR="${SCRIPT_DIR}/scripts"

API_URL="${API_URL:-http://localhost:3000}"
SEED_DATA="${SEED_DATA:-true}"
GENERATE_REPORT="${GENERATE_REPORT:-true}"

# Test selection
TEST_TYPE="${1:-all}"

# Print banner
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  HappyCMDB Load Testing Suite${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Ensure directories exist
mkdir -p "${REPORTS_DIR}"
mkdir -p "${DATA_DIR}"

# Function to check if API is ready
check_api_health() {
    echo -e "${YELLOW}Checking API health...${NC}"

    local max_attempts=30
    local attempt=1

    while [ $attempt -le $max_attempts ]; do
        if curl -f -s "${API_URL}/health" > /dev/null 2>&1; then
            echo -e "${GREEN}✓ API is ready${NC}"
            return 0
        fi

        echo -e "  Attempt $attempt/$max_attempts - waiting for API..."
        sleep 2
        attempt=$((attempt + 1))
    done

    echo -e "${RED}✗ API not available at ${API_URL}${NC}"
    return 1
}

# Function to seed test data
seed_test_data() {
    echo -e "${YELLOW}Seeding test data...${NC}"

    if [ -f "${DATA_DIR}/seed-testdata.js" ]; then
        API_URL="${API_URL}" node "${DATA_DIR}/seed-testdata.js"

        if [ $? -eq 0 ]; then
            echo -e "${GREEN}✓ Test data seeded successfully${NC}"
        else
            echo -e "${RED}✗ Failed to seed test data${NC}"
            return 1
        fi
    else
        echo -e "${YELLOW}⚠ Seed script not found, skipping...${NC}"
    fi
}

# Function to run k6 test
run_k6_test() {
    local test_script="$1"
    local test_name="$2"
    local output_file="${REPORTS_DIR}/${test_name}-results.json"

    echo -e "${BLUE}Running ${test_name} test...${NC}"

    if [ ! -f "${test_script}" ]; then
        echo -e "${RED}✗ Test script not found: ${test_script}${NC}"
        return 1
    fi

    # Run k6 with JSON output
    K6_OUT="json=${output_file}" \
    API_URL="${API_URL}" \
    k6 run \
        --out json="${output_file}" \
        "${test_script}"

    local exit_code=$?

    if [ $exit_code -eq 0 ]; then
        echo -e "${GREEN}✓ ${test_name} test completed successfully${NC}"
    else
        echo -e "${RED}✗ ${test_name} test failed (exit code: ${exit_code})${NC}"
    fi

    return $exit_code
}

# Function to run all tests
run_all_tests() {
    local failed=0

    # API Endpoints Test
    run_k6_test "${SCRIPTS_DIR}/api-endpoints.js" "api-endpoints" || failed=$((failed + 1))

    # GraphQL Test
    run_k6_test "${SCRIPTS_DIR}/graphql-queries.js" "graphql-queries" || failed=$((failed + 1))

    # Discovery Operations Test
    run_k6_test "${SCRIPTS_DIR}/discovery-jobs.js" "discovery-jobs" || failed=$((failed + 1))

    # Database Performance Test
    run_k6_test "${SCRIPTS_DIR}/database-operations.js" "database-operations" || failed=$((failed + 1))

    return $failed
}

# Function to generate summary report
generate_summary_report() {
    echo -e "${YELLOW}Generating summary report...${NC}"

    local summary_file="${REPORTS_DIR}/summary.html"

    cat > "${summary_file}" <<EOF
<!DOCTYPE html>
<html>
<head>
    <title>HappyCMDB Load Test Summary</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }
        h1 { color: #333; border-bottom: 3px solid #007bff; padding-bottom: 10px; }
        .test-link { display: block; margin: 15px 0; padding: 15px; background: #f8f9fa; border-radius: 5px; text-decoration: none; color: #333; }
        .test-link:hover { background: #e9ecef; }
        .timestamp { color: #666; font-size: 14px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>HappyCMDB Load Test Summary</h1>
        <p class="timestamp">Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")</p>

        <h2>Test Reports</h2>

        <a href="api-summary.html" class="test-link">
            <h3>API Endpoints Test</h3>
            <p>REST API performance testing with multiple scenarios (smoke, load, stress, spike)</p>
        </a>

        <a href="graphql-summary.html" class="test-link">
            <h3>GraphQL Queries Test</h3>
            <p>GraphQL API testing with simple, complex, and mixed query workloads</p>
        </a>

        <a href="discovery-summary.html" class="test-link">
            <h3>Discovery Operations Test</h3>
            <p>Discovery job execution, connector performance, and CI persistence throughput</p>
        </a>

        <a href="database-summary.html" class="test-link">
            <h3>Database Performance Test</h3>
            <p>Neo4j, PostgreSQL, and Redis query performance and cache hit rates</p>
        </a>

        <h2>Performance Thresholds</h2>
        <p>See <a href="../performance-thresholds.yml">performance-thresholds.yml</a> for target metrics</p>
    </div>
</body>
</html>
EOF

    echo -e "${GREEN}✓ Summary report generated: ${summary_file}${NC}"
}

# Main execution
main() {
    echo "Test Type: ${TEST_TYPE}"
    echo "API URL: ${API_URL}"
    echo "Seed Data: ${SEED_DATA}"
    echo ""

    # Check API health
    if ! check_api_health; then
        echo -e "${RED}Exiting: API not available${NC}"
        exit 1
    fi

    # Seed test data if requested
    if [ "${SEED_DATA}" == "true" ]; then
        if ! seed_test_data; then
            echo -e "${YELLOW}⚠ Warning: Test data seeding failed, continuing anyway...${NC}"
        fi
    fi

    echo ""

    # Run tests based on type
    case "${TEST_TYPE}" in
        all)
            run_all_tests
            test_result=$?
            ;;
        api|api-endpoints)
            run_k6_test "${SCRIPTS_DIR}/api-endpoints.js" "api-endpoints"
            test_result=$?
            ;;
        graphql|graphql-queries)
            run_k6_test "${SCRIPTS_DIR}/graphql-queries.js" "graphql-queries"
            test_result=$?
            ;;
        discovery|discovery-jobs)
            run_k6_test "${SCRIPTS_DIR}/discovery-jobs.js" "discovery-jobs"
            test_result=$?
            ;;
        database|database-operations)
            run_k6_test "${SCRIPTS_DIR}/database-operations.js" "database-operations"
            test_result=$?
            ;;
        *)
            echo -e "${RED}Unknown test type: ${TEST_TYPE}${NC}"
            echo "Usage: $0 [all|api|graphql|discovery|database]"
            exit 1
            ;;
    esac

    # Generate summary report
    if [ "${GENERATE_REPORT}" == "true" ]; then
        generate_summary_report
    fi

    echo ""
    echo -e "${BLUE}========================================${NC}"

    if [ $test_result -eq 0 ]; then
        echo -e "${GREEN}✓ All tests passed${NC}"
    else
        echo -e "${RED}✗ ${test_result} test(s) failed${NC}"
    fi

    echo -e "${BLUE}========================================${NC}"
    echo ""
    echo "Reports available in: ${REPORTS_DIR}"

    exit $test_result
}

# Run main
main
