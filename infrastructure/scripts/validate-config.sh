#!/bin/bash
# =============================================================================
# HappyCMDB - Configuration Validation Script
# =============================================================================
# Validates environment configuration before deployment
# Usage: ./validate-config.sh [development|staging|production]
# =============================================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Counters
ERRORS=0
WARNINGS=0
PASSED=0

# Environment
ENVIRONMENT="${1:-production}"
ENV_FILE="${2:-.env}"

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# =============================================================================
# Helper Functions
# =============================================================================

print_header() {
  echo -e "${BLUE}========================================${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}========================================${NC}"
}

print_section() {
  echo -e "\n${BLUE}--- $1 ---${NC}"
}

print_error() {
  echo -e "${RED}[ERROR] $1${NC}"
  ((ERRORS++))
}

print_warning() {
  echo -e "${YELLOW}[WARNING] $1${NC}"
  ((WARNINGS++))
}

print_success() {
  echo -e "${GREEN}[PASS] $1${NC}"
  ((PASSED++))
}

print_info() {
  echo -e "${BLUE}[INFO] $1${NC}"
}

check_var() {
  local var_name="$1"
  local var_value="${!var_name:-}"
  local required="${2:-true}"
  local min_length="${3:-0}"
  local pattern="${4:-}"

  if [[ -z "$var_value" ]]; then
    if [[ "$required" == "true" ]]; then
      print_error "$var_name is not set"
      return 1
    else
      print_warning "$var_name is not set (optional)"
      return 0
    fi
  fi

  # Check minimum length
  if [[ ${#var_value} -lt $min_length ]]; then
    print_error "$var_name is too short (min: $min_length chars, got: ${#var_value})"
    return 1
  fi

  # Check pattern
  if [[ -n "$pattern" ]] && ! [[ "$var_value" =~ $pattern ]]; then
    print_error "$var_name does not match required pattern: $pattern"
    return 1
  fi

  print_success "$var_name is set (${#var_value} chars)"
  return 0
}

check_weak_secret() {
  local var_name="$1"
  local var_value="${!var_name:-}"

  # List of weak/default values
  local weak_patterns=(
    "changeme"
    "password"
    "secret"
    "example"
    "your-"
    "REPLACE_WITH"
    "123456"
    "admin"
    "default"
  )

  for pattern in "${weak_patterns[@]}"; do
    if [[ "$var_value" == *"$pattern"* ]]; then
      print_error "$var_name contains weak/default value: '$pattern'"
      return 1
    fi
  done

  print_success "$var_name does not contain weak/default values"
  return 0
}

check_file_exists() {
  local file_path="$1"
  local description="$2"

  if [[ -f "$file_path" ]]; then
    print_success "$description exists: $file_path"
    return 0
  else
    print_error "$description not found: $file_path"
    return 1
  fi
}

check_command() {
  local cmd="$1"
  local description="$2"

  if command -v "$cmd" &> /dev/null; then
    local version=$(eval "$cmd --version 2>&1 | head -n1" || echo "unknown")
    print_success "$description available: $version"
    return 0
  else
    print_error "$description not found: $cmd"
    return 1
  fi
}

check_port_available() {
  local port="$1"
  local service="$2"

  if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
    print_warning "Port $port ($service) is already in use"
    return 1
  else
    print_success "Port $port ($service) is available"
    return 0
  fi
}

check_ssl_cert() {
  local cert_path="$1"
  local description="$2"

  if [[ ! -f "$cert_path" ]]; then
    print_error "SSL certificate not found: $cert_path"
    return 1
  fi

  # Check if certificate is valid
  if openssl x509 -in "$cert_path" -noout -checkend 86400 2>/dev/null; then
    local expiry=$(openssl x509 -in "$cert_path" -noout -enddate 2>/dev/null | cut -d= -f2)
    print_success "$description is valid (expires: $expiry)"
    return 0
  else
    print_error "$description is expired or invalid"
    return 1
  fi
}

# =============================================================================
# Load Environment File
# =============================================================================

print_header "HappyCMDB Configuration Validator"
print_info "Environment: $ENVIRONMENT"
print_info "Config file: $ENV_FILE"

if [[ ! -f "$PROJECT_ROOT/$ENV_FILE" ]]; then
  print_error "Environment file not found: $PROJECT_ROOT/$ENV_FILE"
  exit 1
fi

# Load environment variables
set -a
source "$PROJECT_ROOT/$ENV_FILE"
set +a

print_success "Loaded environment file: $ENV_FILE"

# =============================================================================
# Validation: Required Environment Variables
# =============================================================================

print_section "Required Environment Variables"

check_var NODE_ENV true 1 "^(development|staging|production)$"
check_var LOG_LEVEL true 1 "^(debug|info|warn|error)$"
check_var API_PORT true 1 "^[0-9]+$"
check_var API_HOST true 1

# =============================================================================
# Validation: Security Secrets
# =============================================================================

print_section "Security Secrets"

# Check JWT secret
if check_var JWT_SECRET true 32; then
  if [[ "$ENVIRONMENT" != "development" ]]; then
    check_weak_secret JWT_SECRET
  fi
fi

# Check encryption key
if check_var ENCRYPTION_KEY true 32; then
  if [[ "$ENVIRONMENT" != "development" ]]; then
    check_weak_secret ENCRYPTION_KEY
  fi
fi

# Check API key
if check_var API_KEY true 16; then
  if [[ "$ENVIRONMENT" != "development" ]]; then
    check_weak_secret API_KEY
  fi
fi

# Check rate limit bypass secret
if check_var RATE_LIMIT_BYPASS_SECRET true 16; then
  if [[ "$ENVIRONMENT" != "development" ]]; then
    check_weak_secret RATE_LIMIT_BYPASS_SECRET
  fi
fi

# =============================================================================
# Validation: SSL/TLS Configuration
# =============================================================================

print_section "SSL/TLS Configuration"

check_var SSL_ENABLED true 1 "^(true|false)$"

if [[ "${SSL_ENABLED:-false}" == "true" ]]; then
  check_var NGINX_SSL_ENABLED true 1 "^(true|false)$"
  check_var NGINX_SSL_CERT_PATH true 1
  check_var NGINX_SSL_KEY_PATH true 1
  check_var NGINX_SSL_CHAIN_PATH false 1
  check_var NGINX_SSL_DHPARAM_PATH true 1

  # Production-specific SSL checks
  if [[ "$ENVIRONMENT" == "production" ]]; then
    if [[ "${SSL_ENABLED}" != "true" ]]; then
      print_error "SSL MUST be enabled in production"
    else
      print_success "SSL is enabled for production"
    fi

    # Check certificate files (if using local files)
    # Note: This assumes certificates are mounted in Docker
    # In production, these should be managed by Let's Encrypt or a secrets manager
    print_info "SSL certificate validation skipped (assumes Docker volume mount)"
  fi
else
  if [[ "$ENVIRONMENT" == "production" ]]; then
    print_error "SSL is DISABLED in production environment!"
  else
    print_warning "SSL is disabled (not recommended for $ENVIRONMENT)"
  fi
fi

# =============================================================================
# Validation: Database Configuration
# =============================================================================

print_section "Neo4j Configuration"

check_var NEO4J_URI true 10
check_var NEO4J_USERNAME true 1
if check_var NEO4J_PASSWORD true 8; then
  if [[ "$ENVIRONMENT" != "development" ]]; then
    check_weak_secret NEO4J_PASSWORD
  fi
fi
check_var NEO4J_DATABASE true 1
check_var NEO4J_MAX_CONNECTION_POOL_SIZE true 1 "^[0-9]+$"
check_var NEO4J_CONNECTION_TIMEOUT true 1 "^[0-9]+$"

# Neo4j SSL checks
if [[ "$ENVIRONMENT" == "production" ]]; then
  if [[ "${NEO4J_SSL_ENABLED:-false}" != "true" ]]; then
    print_warning "Neo4j SSL is not enabled in production"
  fi
  if [[ "${NEO4J_BOLT_TLS_LEVEL:-OPTIONAL}" != "REQUIRED" ]]; then
    print_warning "Neo4j TLS level should be REQUIRED in production"
  fi
fi

print_section "PostgreSQL Configuration"

check_var POSTGRES_HOST true 1
check_var POSTGRES_PORT true 1 "^[0-9]+$"
check_var POSTGRES_DATABASE true 1
check_var POSTGRES_USER true 1
if check_var POSTGRES_PASSWORD true 8; then
  if [[ "$ENVIRONMENT" != "development" ]]; then
    check_weak_secret POSTGRES_PASSWORD
  fi
fi
check_var POSTGRES_MAX_CONNECTIONS true 1 "^[0-9]+$"

# PostgreSQL SSL checks
if [[ "$ENVIRONMENT" == "production" ]]; then
  if [[ "${POSTGRES_SSL_ENABLED:-off}" != "on" ]]; then
    print_warning "PostgreSQL SSL is not enabled in production"
  fi
  if [[ "${POSTGRES_SSL_MODE:-prefer}" != "require" ]] && [[ "${POSTGRES_SSL_MODE:-prefer}" != "verify-ca" ]] && [[ "${POSTGRES_SSL_MODE:-prefer}" != "verify-full" ]]; then
    print_warning "PostgreSQL SSL mode should be 'require' or stronger in production"
  fi
fi

print_section "Redis Configuration"

check_var REDIS_HOST true 1
check_var REDIS_PORT true 1 "^[0-9]+$"
check_var REDIS_DB true 1 "^[0-9]+$"
check_var REDIS_KEY_PREFIX true 1

# Redis password check (optional but recommended)
if [[ -n "${REDIS_PASSWORD:-}" ]]; then
  if [[ "$ENVIRONMENT" != "development" ]]; then
    check_weak_secret REDIS_PASSWORD || true
  fi
  print_success "Redis password is set"
else
  if [[ "$ENVIRONMENT" == "production" ]]; then
    print_warning "Redis password is not set (recommended for production)"
  fi
fi

# Redis SSL checks
if [[ "$ENVIRONMENT" == "production" ]]; then
  if [[ "${REDIS_TLS_ENABLED:-false}" != "true" ]]; then
    print_warning "Redis TLS is not enabled in production (recommended)"
  fi
fi

# =============================================================================
# Validation: Rate Limiting
# =============================================================================

print_section "Rate Limiting Configuration"

check_var RATE_LIMIT_ENABLED true 1 "^(true|false)$"

if [[ "${RATE_LIMIT_ENABLED}" == "true" ]]; then
  check_var RATE_LIMIT_REST_MAX true 1 "^[0-9]+$"
  check_var RATE_LIMIT_GRAPHQL_MAX true 1 "^[0-9]+$"
  check_var RATE_LIMIT_AUTH_MAX true 1 "^[0-9]+$"

  # Production-specific rate limit checks
  if [[ "$ENVIRONMENT" == "production" ]]; then
    local auth_max="${RATE_LIMIT_AUTH_MAX:-0}"
    if [[ $auth_max -gt 20 ]]; then
      print_warning "Auth rate limit is high ($auth_max) - consider lowering to prevent brute force"
    fi
  fi
fi

# =============================================================================
# Validation: Backup Configuration
# =============================================================================

print_section "Backup Configuration"

check_var BACKUP_DIR true 1
check_var BACKUP_RETENTION_DAILY true 1 "^[0-9]+$"
check_var BACKUP_RETENTION_WEEKLY true 1 "^[0-9]+$"
check_var BACKUP_RETENTION_MONTHLY true 1 "^[0-9]+$"

if [[ "$ENVIRONMENT" == "production" ]]; then
  if [[ "${BACKUP_UPLOAD_ENABLED:-false}" != "true" ]]; then
    print_warning "Cloud backup upload is disabled in production (recommended: enable)"
  else
    print_success "Cloud backup upload is enabled"

    # Check cloud storage credentials
    if [[ "${BACKUP_STORAGE_TYPE:-s3}" == "s3" ]]; then
      check_var BACKUP_S3_BUCKET true 1
      check_var AWS_ACCESS_KEY_ID true 16
      check_var AWS_SECRET_ACCESS_KEY true 32
      check_var AWS_DEFAULT_REGION true 1
    elif [[ "${BACKUP_STORAGE_TYPE}" == "azure" ]]; then
      check_var BACKUP_AZURE_CONTAINER true 1
      check_var AZURE_STORAGE_ACCOUNT true 1
      check_var AZURE_STORAGE_ACCESS_KEY true 32
    fi
  fi

  if [[ "${BACKUP_NOTIFICATION_ENABLED:-false}" != "true" ]]; then
    print_warning "Backup notifications are disabled in production (recommended: enable)"
  fi
fi

# =============================================================================
# Validation: Monitoring & Observability
# =============================================================================

print_section "Monitoring Configuration"

check_var METRICS_ENABLED true 1 "^(true|false)$"
check_var AUDIT_LOG_ENABLED true 1 "^(true|false)$"

if [[ "$ENVIRONMENT" == "production" ]]; then
  if [[ "${METRICS_ENABLED}" != "true" ]]; then
    print_error "Metrics MUST be enabled in production"
  fi
  if [[ "${AUDIT_LOG_ENABLED}" != "true" ]]; then
    print_error "Audit logging MUST be enabled in production"
  fi
fi

# =============================================================================
# Validation: Resource Limits
# =============================================================================

print_section "Resource Configuration"

# Check if running in Docker environment
if [[ -f "/.dockerenv" ]] || grep -q docker /proc/1/cgroup 2>/dev/null; then
  print_info "Running in Docker environment"

  # Check memory limits (if available)
  if [[ -f "/sys/fs/cgroup/memory/memory.limit_in_bytes" ]]; then
    local mem_limit=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)
    local mem_limit_gb=$((mem_limit / 1024 / 1024 / 1024))
    if [[ $mem_limit_gb -lt 2 ]]; then
      print_warning "Memory limit is low: ${mem_limit_gb}GB (recommended: min 4GB for production)"
    else
      print_success "Memory limit: ${mem_limit_gb}GB"
    fi
  fi
else
  print_info "Not running in Docker environment"
fi

# =============================================================================
# Validation: System Dependencies
# =============================================================================

print_section "System Dependencies"

check_command "docker" "Docker" || true
check_command "docker-compose" "Docker Compose" || true
check_command "openssl" "OpenSSL" || true
check_command "curl" "cURL" || true

# =============================================================================
# Validation: Port Availability
# =============================================================================

print_section "Port Availability"

# Only check ports if not in Docker
if [[ ! -f "/.dockerenv" ]] && ! grep -q docker /proc/1/cgroup 2>/dev/null; then
  check_port_available "${API_PORT:-3000}" "API Server" || true
  check_port_available "7474" "Neo4j HTTP" || true
  check_port_available "7687" "Neo4j Bolt" || true
  check_port_available "5432" "PostgreSQL" || true
  check_port_available "6379" "Redis" || true
  check_port_available "80" "HTTP" || true
  check_port_available "443" "HTTPS" || true
else
  print_info "Skipping port checks (running in Docker)"
fi

# =============================================================================
# Validation: Grafana Configuration
# =============================================================================

print_section "Grafana Configuration"

check_var GRAFANA_ADMIN_USER true 1
if check_var GRAFANA_ADMIN_PASSWORD true 8; then
  if [[ "$ENVIRONMENT" != "development" ]]; then
    check_weak_secret GRAFANA_ADMIN_PASSWORD
  fi
fi

if [[ "$ENVIRONMENT" == "production" ]]; then
  if [[ "${GRAFANA_ANONYMOUS_ENABLED:-false}" == "true" ]]; then
    print_warning "Grafana anonymous access is enabled in production (security risk)"
  else
    print_success "Grafana anonymous access is disabled"
  fi
fi

# =============================================================================
# Production-Specific Checks
# =============================================================================

if [[ "$ENVIRONMENT" == "production" ]]; then
  print_section "Production-Specific Checks"

  # Check NODE_ENV
  if [[ "${NODE_ENV}" != "production" ]]; then
    print_error "NODE_ENV must be 'production' in production environment"
  else
    print_success "NODE_ENV is set to 'production'"
  fi

  # Check LOG_LEVEL
  if [[ "${LOG_LEVEL}" == "debug" ]]; then
    print_warning "LOG_LEVEL is 'debug' in production (performance impact)"
  elif [[ "${LOG_LEVEL}" == "info" ]] || [[ "${LOG_LEVEL}" == "warn" ]] || [[ "${LOG_LEVEL}" == "error" ]]; then
    print_success "LOG_LEVEL is appropriate for production: ${LOG_LEVEL}"
  fi

  # Check discovery/ETL settings
  if [[ "${DISCOVERY_ENABLED:-true}" == "true" ]]; then
    print_success "Discovery is enabled"
  fi
  if [[ "${ETL_ENABLED:-true}" == "true" ]]; then
    print_success "ETL is enabled"
  fi

  # Check AI/ML features
  if [[ "${AI_ANOMALY_DETECTION_ENABLED:-false}" == "true" ]]; then
    print_success "AI anomaly detection is enabled"
  fi
fi

# =============================================================================
# Summary
# =============================================================================

print_header "Validation Summary"

echo -e "${GREEN}Passed:   $PASSED${NC}"
echo -e "${YELLOW}Warnings: $WARNINGS${NC}"
echo -e "${RED}Errors:   $ERRORS${NC}"

if [[ $ERRORS -gt 0 ]]; then
  echo -e "\n${RED}Configuration validation FAILED${NC}"
  echo -e "${RED}Please fix the errors above before deploying${NC}"
  exit 1
elif [[ $WARNINGS -gt 0 ]]; then
  echo -e "\n${YELLOW}Configuration validation PASSED with WARNINGS${NC}"
  echo -e "${YELLOW}Review warnings above before deploying to production${NC}"
  exit 0
else
  echo -e "\n${GREEN}Configuration validation PASSED${NC}"
  echo -e "${GREEN}All checks passed successfully${NC}"
  exit 0
fi
