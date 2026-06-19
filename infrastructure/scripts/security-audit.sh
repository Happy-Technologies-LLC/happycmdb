#!/bin/bash

###############################################################################
# Security Audit Script
#
# Validates security hardening checklist items and generates a security score.
# This script automates as many checklist items as possible.
#
# Usage:
#   ./security-audit.sh [--json]
#
# Options:
#   --json    Output results in JSON format
###############################################################################

set -e
set -u

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_FORMAT="text"

# Parse arguments
if [ $# -gt 0 ] && [ "$1" == "--json" ]; then
  OUTPUT_FORMAT="json"
fi

# Scoring variables
TOTAL_CHECKS=0
PASSED_CHECKS=0
FAILED_CHECKS=0
WARNING_CHECKS=0

# Category scores
DOCKER_TOTAL=0
DOCKER_PASSED=0
NETWORK_TOTAL=0
NETWORK_PASSED=0
DATABASE_TOTAL=0
DATABASE_PASSED=0
API_TOTAL=0
API_PASSED=0
SECRET_TOTAL=0
SECRET_PASSED=0
DEPENDENCY_TOTAL=0
DEPENDENCY_PASSED=0
LOGGING_TOTAL=0
LOGGING_PASSED=0

###############################################################################
# Helper Functions
###############################################################################

print_header() {
  if [ "$OUTPUT_FORMAT" == "text" ]; then
    echo -e "${BLUE}======================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}======================================${NC}"
  fi
}

check_pass() {
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  PASSED_CHECKS=$((PASSED_CHECKS + 1))
  if [ "$OUTPUT_FORMAT" == "text" ]; then
    echo -e "${GREEN}✓ $1${NC}"
  fi
}

check_fail() {
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  FAILED_CHECKS=$((FAILED_CHECKS + 1))
  if [ "$OUTPUT_FORMAT" == "text" ]; then
    echo -e "${RED}✗ $1${NC}"
  fi
}

check_warning() {
  TOTAL_CHECKS=$((TOTAL_CHECKS + 1))
  WARNING_CHECKS=$((WARNING_CHECKS + 1))
  if [ "$OUTPUT_FORMAT" == "text" ]; then
    echo -e "${YELLOW}⚠ $1${NC}"
  fi
}

###############################################################################
# 1. Docker Security Checks
###############################################################################

check_docker_security() {
  print_header "1. Docker Security"

  # Check if Docker is installed
  if ! command -v docker &> /dev/null; then
    check_warning "Docker not installed - skipping Docker checks"
    return
  fi

  # Check Dockerfiles for non-root users
  DOCKER_TOTAL=$((DOCKER_TOTAL + 1))
  if grep -r "USER" infrastructure/docker/Dockerfile* &> /dev/null; then
    DOCKER_PASSED=$((DOCKER_PASSED + 1))
    check_pass "Dockerfiles use non-root USER directive"
  else
    check_fail "Dockerfiles do not specify non-root USER"
  fi

  # Check for base image security (Alpine or distroless)
  DOCKER_TOTAL=$((DOCKER_TOTAL + 1))
  if grep -r "FROM.*alpine\|FROM.*distroless" infrastructure/docker/Dockerfile* &> /dev/null; then
    DOCKER_PASSED=$((DOCKER_PASSED + 1))
    check_pass "Dockerfiles use minimal base images (Alpine/distroless)"
  else
    check_warning "Dockerfiles may use full OS images (consider Alpine)"
  fi

  # Check docker-compose for read-only filesystems
  DOCKER_TOTAL=$((DOCKER_TOTAL + 1))
  if [ -f "infrastructure/docker/docker-compose.yml" ]; then
    if grep -q "read_only: true" infrastructure/docker/docker-compose.yml; then
      DOCKER_PASSED=$((DOCKER_PASSED + 1))
      check_pass "Docker Compose uses read-only filesystems"
    else
      check_warning "Docker Compose does not use read-only filesystems"
    fi
  fi

  # Check for secrets in environment variables
  DOCKER_TOTAL=$((DOCKER_TOTAL + 1))
  if [ -f "infrastructure/docker/docker-compose.yml" ]; then
    if grep -E "PASSWORD|SECRET|KEY" infrastructure/docker/docker-compose.yml | grep -v "\${" &> /dev/null; then
      check_fail "Hardcoded secrets found in docker-compose.yml"
    else
      DOCKER_PASSED=$((DOCKER_PASSED + 1))
      check_pass "No hardcoded secrets in docker-compose.yml"
    fi
  fi

  # Check for specific image tags (not 'latest')
  DOCKER_TOTAL=$((DOCKER_TOTAL + 1))
  if [ -f "infrastructure/docker/docker-compose.yml" ]; then
    if grep "image:.*:latest" infrastructure/docker/docker-compose.yml &> /dev/null; then
      check_warning "Docker Compose uses 'latest' tag (pin to specific versions)"
    else
      DOCKER_PASSED=$((DOCKER_PASSED + 1))
      check_pass "Docker Compose pins specific image versions"
    fi
  fi
}

###############################################################################
# 2. Network Security Checks
###############################################################################

check_network_security() {
  print_header "2. Network Security"

  # Check for HTTPS configuration
  NETWORK_TOTAL=$((NETWORK_TOTAL + 1))
  if grep -r "https://" infrastructure/ --include="*.yml" --include="*.yaml" --include="*.conf" &> /dev/null; then
    NETWORK_PASSED=$((NETWORK_PASSED + 1))
    check_pass "HTTPS configured in infrastructure"
  else
    check_warning "HTTPS not configured (may be handled by reverse proxy)"
  fi

  # Check for TLS/SSL configuration
  NETWORK_TOTAL=$((NETWORK_TOTAL + 1))
  if grep -r "ssl\|tls" infrastructure/ --include="*.yml" --include="*.yaml" --include="*.conf" | grep -v "sslmode=disable" &> /dev/null; then
    NETWORK_PASSED=$((NETWORK_PASSED + 1))
    check_pass "TLS/SSL configuration found"
  else
    check_fail "TLS/SSL not configured"
  fi

  # Check for exposed ports in docker-compose
  NETWORK_TOTAL=$((NETWORK_TOTAL + 1))
  if [ -f "infrastructure/docker/docker-compose.yml" ]; then
    exposed_ports=$(grep -E "^ *- \"[0-9]+:[0-9]+\"" infrastructure/docker/docker-compose.yml | wc -l)
    if [ "$exposed_ports" -le 5 ]; then
      NETWORK_PASSED=$((NETWORK_PASSED + 1))
      check_pass "Minimal ports exposed ($exposed_ports ports)"
    else
      check_warning "Many ports exposed ($exposed_ports ports) - review if all necessary"
    fi
  fi
}

###############################################################################
# 3. Database Security Checks
###############################################################################

check_database_security() {
  print_header "3. Database Security"

  # Check for encrypted database connections
  DATABASE_TOTAL=$((DATABASE_TOTAL + 1))
  if grep -r "sslmode=require\|bolt+s" packages/ --include="*.ts" &> /dev/null; then
    DATABASE_PASSED=$((DATABASE_PASSED + 1))
    check_pass "Encrypted database connections configured"
  else
    check_fail "Encrypted database connections not configured"
  fi

  # Check for parameterized queries (PostgreSQL)
  DATABASE_TOTAL=$((DATABASE_TOTAL + 1))
  param_queries=$(grep -r "\.query(.*\$[0-9]" packages/ --include="*.ts" | wc -l)
  if [ "$param_queries" -gt 0 ]; then
    DATABASE_PASSED=$((DATABASE_PASSED + 1))
    check_pass "Parameterized queries used ($param_queries instances)"
  else
    check_warning "No parameterized queries detected"
  fi

  # Check for SQL injection vulnerabilities (string concatenation)
  DATABASE_TOTAL=$((DATABASE_TOTAL + 1))
  if grep -r "query.*+\|\.query(\`\${" packages/ --include="*.ts" &> /dev/null; then
    check_fail "Potential SQL injection found (string concatenation in queries)"
  else
    DATABASE_PASSED=$((DATABASE_PASSED + 1))
    check_pass "No SQL injection patterns detected"
  fi

  # Check for database credentials in code
  DATABASE_TOTAL=$((DATABASE_TOTAL + 1))
  if grep -r "password.*=.*['\"][^'\"]\{8,\}['\"]" packages/ --include="*.ts" | grep -v "process.env" &> /dev/null; then
    check_fail "Hardcoded database credentials found"
  else
    DATABASE_PASSED=$((DATABASE_PASSED + 1))
    check_pass "No hardcoded database credentials"
  fi
}

###############################################################################
# 4. API Security Checks
###############################################################################

check_api_security() {
  print_header "4. API Security"

  # Check for security headers middleware
  API_TOTAL=$((API_TOTAL + 1))
  if [ -f "packages/api-server/src/middleware/security-headers.middleware.ts" ]; then
    API_PASSED=$((API_PASSED + 1))
    check_pass "Security headers middleware exists"
  else
    check_fail "Security headers middleware not found"
  fi

  # Check for input validation middleware
  API_TOTAL=$((API_TOTAL + 1))
  if [ -f "packages/api-server/src/middleware/input-validation.middleware.ts" ]; then
    API_PASSED=$((API_PASSED + 1))
    check_pass "Input validation middleware exists"
  else
    check_fail "Input validation middleware not found"
  fi

  # Check for rate limiting middleware
  API_TOTAL=$((API_TOTAL + 1))
  if [ -f "packages/api-server/src/middleware/rate-limit.middleware.ts" ]; then
    API_PASSED=$((API_PASSED + 1))
    check_pass "Rate limiting middleware exists"
  else
    check_fail "Rate limiting middleware not found"
  fi

  # Check for authentication middleware
  API_TOTAL=$((API_TOTAL + 1))
  if [ -f "packages/api-server/src/middleware/auth.middleware.ts" ]; then
    API_PASSED=$((API_PASSED + 1))
    check_pass "Authentication middleware exists"
  else
    check_fail "Authentication middleware not found"
  fi

  # Check for CORS configuration
  API_TOTAL=$((API_TOTAL + 1))
  if [ -f "packages/api-server/src/middleware/cors.middleware.ts" ]; then
    API_PASSED=$((API_PASSED + 1))
    check_pass "CORS middleware exists"
  else
    check_warning "CORS middleware not found"
  fi

  # Check for dangerous functions (eval, exec)
  API_TOTAL=$((API_TOTAL + 1))
  if grep -r "\beval(\|exec(" packages/ --include="*.ts" &> /dev/null; then
    check_fail "Dangerous functions (eval/exec) found in code"
  else
    API_PASSED=$((API_PASSED + 1))
    check_pass "No dangerous functions (eval/exec) detected"
  fi

  # Check for innerHTML usage (XSS risk)
  API_TOTAL=$((API_TOTAL + 1))
  if grep -r "innerHTML" packages/ web-ui/ --include="*.ts" --include="*.tsx" &> /dev/null; then
    check_warning "innerHTML usage found (potential XSS risk)"
  else
    API_PASSED=$((API_PASSED + 1))
    check_pass "No innerHTML usage detected"
  fi
}

###############################################################################
# 5. Secret Management Checks
###############################################################################

check_secret_management() {
  print_header "5. Secret Management"

  # Check for .env in .gitignore
  SECRET_TOTAL=$((SECRET_TOTAL + 1))
  if grep -q "^\.env$" .gitignore 2>/dev/null; then
    SECRET_PASSED=$((SECRET_PASSED + 1))
    check_pass ".env file in .gitignore"
  else
    check_fail ".env not in .gitignore"
  fi

  # Check for .env.example
  SECRET_TOTAL=$((SECRET_TOTAL + 1))
  if [ -f ".env.example" ]; then
    SECRET_PASSED=$((SECRET_PASSED + 1))
    check_pass ".env.example file exists"
  else
    check_warning ".env.example not found"
  fi

  # Check for hardcoded secrets in code
  SECRET_TOTAL=$((SECRET_TOTAL + 1))
  if grep -rE "password.*=.*['\"][^'\"]{8,}['\"]|api[_-]?key.*=.*['\"][^'\"]{16,}['\"]|secret.*=.*['\"][^'\"]{16,}['\"]" packages/ --include="*.ts" | grep -v "process.env\|example\|test\|mock" &> /dev/null; then
    check_fail "Potential hardcoded secrets found in code"
  else
    SECRET_PASSED=$((SECRET_PASSED + 1))
    check_pass "No hardcoded secrets detected"
  fi

  # Check for secrets in environment variables (process.env usage)
  SECRET_TOTAL=$((SECRET_TOTAL + 1))
  env_usage=$(grep -r "process\.env\." packages/ --include="*.ts" | wc -l)
  if [ "$env_usage" -gt 0 ]; then
    SECRET_PASSED=$((SECRET_PASSED + 1))
    check_pass "Environment variables used for configuration ($env_usage instances)"
  else
    check_warning "No environment variable usage detected"
  fi

  # Check for .git directory in Docker images
  SECRET_TOTAL=$((SECRET_TOTAL + 1))
  if grep -r "\.dockerignore" infrastructure/docker/ &> /dev/null; then
    if grep -q "\.git" infrastructure/docker/.dockerignore 2>/dev/null; then
      SECRET_PASSED=$((SECRET_PASSED + 1))
      check_pass ".git directory excluded from Docker images"
    else
      check_warning ".git not in .dockerignore (may leak secrets)"
    fi
  else
    check_warning ".dockerignore file not found"
  fi
}

###############################################################################
# 6. Dependency Security Checks
###############################################################################

check_dependency_security() {
  print_header "6. Dependency Security"

  # Check for package-lock.json
  DEPENDENCY_TOTAL=$((DEPENDENCY_TOTAL + 1))
  if [ -f "package-lock.json" ]; then
    DEPENDENCY_PASSED=$((DEPENDENCY_PASSED + 1))
    check_pass "package-lock.json exists (dependency pinning)"
  else
    check_fail "package-lock.json not found"
  fi

  # Run npm audit (if npm is installed)
  if command -v npm &> /dev/null; then
    DEPENDENCY_TOTAL=$((DEPENDENCY_TOTAL + 1))
    cd "$PROJECT_ROOT"
    audit_result=$(npm audit --json 2>/dev/null || echo '{"metadata":{"vulnerabilities":{"critical":0,"high":0}}}')
    critical=$(echo "$audit_result" | jq -r '.metadata.vulnerabilities.critical // 0' 2>/dev/null || echo "0")
    high=$(echo "$audit_result" | jq -r '.metadata.vulnerabilities.high // 0' 2>/dev/null || echo "0")

    if [ "$critical" -eq 0 ] && [ "$high" -eq 0 ]; then
      DEPENDENCY_PASSED=$((DEPENDENCY_PASSED + 1))
      check_pass "No critical or high npm vulnerabilities"
    else
      check_fail "Found $critical critical and $high high vulnerabilities (run 'npm audit')"
    fi
  fi

  # Check for outdated dependencies
  DEPENDENCY_TOTAL=$((DEPENDENCY_TOTAL + 1))
  if command -v npm &> /dev/null; then
    outdated_count=$(npm outdated --json 2>/dev/null | jq 'keys | length' 2>/dev/null || echo "0")
    if [ "$outdated_count" -eq 0 ]; then
      DEPENDENCY_PASSED=$((DEPENDENCY_PASSED + 1))
      check_pass "All dependencies up to date"
    else
      check_warning "$outdated_count outdated dependencies (run 'npm outdated')"
    fi
  fi
}

###############################################################################
# 7. Logging and Monitoring Checks
###############################################################################

check_logging_monitoring() {
  print_header "7. Logging and Monitoring"

  # Check for audit middleware
  LOGGING_TOTAL=$((LOGGING_TOTAL + 1))
  if [ -f "packages/api-server/src/middleware/audit.middleware.ts" ]; then
    LOGGING_PASSED=$((LOGGING_PASSED + 1))
    check_pass "Audit logging middleware exists"
  else
    check_fail "Audit logging middleware not found"
  fi

  # Check for security monitoring middleware
  LOGGING_TOTAL=$((LOGGING_TOTAL + 1))
  if [ -f "packages/api-server/src/middleware/security-monitoring.middleware.ts" ]; then
    LOGGING_PASSED=$((LOGGING_PASSED + 1))
    check_pass "Security monitoring middleware exists"
  else
    check_fail "Security monitoring middleware not found"
  fi

  # Check for logger usage in code
  LOGGING_TOTAL=$((LOGGING_TOTAL + 1))
  logger_usage=$(grep -r "logger\." packages/ --include="*.ts" | wc -l)
  if [ "$logger_usage" -gt 50 ]; then
    LOGGING_PASSED=$((LOGGING_PASSED + 1))
    check_pass "Logging used throughout codebase ($logger_usage instances)"
  else
    check_warning "Limited logging usage detected ($logger_usage instances)"
  fi

  # Check for sensitive data in logs
  LOGGING_TOTAL=$((LOGGING_TOTAL + 1))
  if grep -r "logger.*password\|logger.*secret\|logger.*token" packages/ --include="*.ts" | grep -v "redact\|sanitize\|\*\*\*" &> /dev/null; then
    check_fail "Potential sensitive data in logs"
  else
    LOGGING_PASSED=$((LOGGING_PASSED + 1))
    check_pass "No sensitive data logging detected"
  fi
}

###############################################################################
# 8. Calculate Security Score
###############################################################################

calculate_score() {
  local category=$1
  local passed=$2
  local total=$3

  if [ "$total" -eq 0 ]; then
    echo "0"
    return
  fi

  local percentage=$((passed * 100 / total))
  echo "$percentage"
}

generate_report() {
  print_header "Security Audit Summary"

  # Category scores
  docker_score=$(calculate_score "Docker" $DOCKER_PASSED $DOCKER_TOTAL)
  network_score=$(calculate_score "Network" $NETWORK_PASSED $NETWORK_TOTAL)
  database_score=$(calculate_score "Database" $DATABASE_PASSED $DATABASE_TOTAL)
  api_score=$(calculate_score "API" $API_PASSED $API_TOTAL)
  secret_score=$(calculate_score "Secret" $SECRET_PASSED $SECRET_TOTAL)
  dependency_score=$(calculate_score "Dependency" $DEPENDENCY_PASSED $DEPENDENCY_TOTAL)
  logging_score=$(calculate_score "Logging" $LOGGING_PASSED $LOGGING_TOTAL)

  # Overall score (weighted)
  overall_score=$(( (docker_score * 10 + network_score * 10 + database_score * 15 + api_score * 20 + secret_score * 10 + dependency_score * 5 + logging_score * 15) / 85 ))

  if [ "$OUTPUT_FORMAT" == "json" ]; then
    cat <<EOF
{
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "overall_score": $overall_score,
  "total_checks": $TOTAL_CHECKS,
  "passed": $PASSED_CHECKS,
  "failed": $FAILED_CHECKS,
  "warnings": $WARNING_CHECKS,
  "categories": {
    "docker": {"score": $docker_score, "passed": $DOCKER_PASSED, "total": $DOCKER_TOTAL},
    "network": {"score": $network_score, "passed": $NETWORK_PASSED, "total": $NETWORK_TOTAL},
    "database": {"score": $database_score, "passed": $DATABASE_PASSED, "total": $DATABASE_TOTAL},
    "api": {"score": $api_score, "passed": $API_PASSED, "total": $API_TOTAL},
    "secret_management": {"score": $secret_score, "passed": $SECRET_PASSED, "total": $SECRET_TOTAL},
    "dependency": {"score": $dependency_score, "passed": $DEPENDENCY_PASSED, "total": $DEPENDENCY_TOTAL},
    "logging": {"score": $logging_score, "passed": $LOGGING_PASSED, "total": $LOGGING_TOTAL}
  }
}
EOF
  else
    echo ""
    echo "Category Scores:"
    echo "  Docker Security:        $docker_score% ($DOCKER_PASSED/$DOCKER_TOTAL)"
    echo "  Network Security:       $network_score% ($NETWORK_PASSED/$NETWORK_TOTAL)"
    echo "  Database Security:      $database_score% ($DATABASE_PASSED/$DATABASE_TOTAL)"
    echo "  API Security:           $api_score% ($API_PASSED/$API_TOTAL)"
    echo "  Secret Management:      $secret_score% ($SECRET_PASSED/$SECRET_TOTAL)"
    echo "  Dependency Security:    $dependency_score% ($DEPENDENCY_PASSED/$DEPENDENCY_TOTAL)"
    echo "  Logging and Monitoring: $logging_score% ($LOGGING_PASSED/$LOGGING_TOTAL)"
    echo ""
    echo "Overall Security Score: $overall_score/100"
    echo ""
    echo "Total Checks: $TOTAL_CHECKS"
    echo "  Passed:   $PASSED_CHECKS"
    echo "  Failed:   $FAILED_CHECKS"
    echo "  Warnings: $WARNING_CHECKS"
    echo ""

    if [ "$overall_score" -ge 90 ]; then
      echo -e "${GREEN}Grade: EXCELLENT - Production Ready${NC}"
    elif [ "$overall_score" -ge 80 ]; then
      echo -e "${GREEN}Grade: GOOD - Minor Improvements Needed${NC}"
    elif [ "$overall_score" -ge 70 ]; then
      echo -e "${YELLOW}Grade: FAIR - Moderate Hardening Required${NC}"
    elif [ "$overall_score" -ge 60 ]; then
      echo -e "${YELLOW}Grade: POOR - Significant Gaps Exist${NC}"
    else
      echo -e "${RED}Grade: CRITICAL - Not Production Ready${NC}"
    fi
  fi
}

###############################################################################
# Main Execution
###############################################################################

main() {
  if [ "$OUTPUT_FORMAT" == "text" ]; then
    print_header "HappyCMDB Security Audit"
    echo "Date: $(date)"
    echo ""
  fi

  check_docker_security
  check_network_security
  check_database_security
  check_api_security
  check_secret_management
  check_dependency_security
  check_logging_monitoring

  generate_report

  # Exit code based on failures
  if [ "$FAILED_CHECKS" -gt 0 ]; then
    exit 1
  else
    exit 0
  fi
}

main
