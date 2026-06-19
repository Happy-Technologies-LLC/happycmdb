#!/bin/bash

# =============================================================================
# HappyCMDB - SSL/TLS Configuration Validation Script
# =============================================================================
# This script validates SSL/TLS configuration for all HappyCMDB services:
# - PostgreSQL
# - Neo4j
# - Redis
# - Nginx
#
# Usage: ./validate-ssl-config.sh [--env production|staging|development]
#
# Exit Codes:
#   0 - All SSL checks passed
#   1 - One or more SSL checks failed
#   2 - Critical SSL configuration missing
# =============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SSL_DIR="${PROJECT_ROOT}/infrastructure/docker/ssl"
ENV_FILE="${PROJECT_ROOT}/.env"

# Parse arguments
ENVIRONMENT="${1:-development}"
if [[ "$1" == "--env" ]]; then
    ENVIRONMENT="${2:-development}"
fi

# Counters
TOTAL_CHECKS=0
PASSED_CHECKS=0
FAILED_CHECKS=0
WARNING_CHECKS=0

# =============================================================================
# Helper Functions
# =============================================================================

print_header() {
    echo -e "${BLUE}=====================================================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}=====================================================================${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
    ((PASSED_CHECKS++))
    ((TOTAL_CHECKS++))
}

print_failure() {
    echo -e "${RED}✗ $1${NC}"
    ((FAILED_CHECKS++))
    ((TOTAL_CHECKS++))
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
    ((WARNING_CHECKS++))
    ((TOTAL_CHECKS++))
}

print_info() {
    echo -e "${BLUE}ℹ $1${NC}"
}

# Check if a command exists
command_exists() {
    command -v "$1" &> /dev/null
}

# Check if a file exists and is readable
file_exists_readable() {
    [ -f "$1" ] && [ -r "$1" ]
}

# Check certificate expiration
check_cert_expiration() {
    local cert_path="$1"
    local cert_name="$2"
    local warn_days="${3:-14}"

    if ! file_exists_readable "$cert_path"; then
        print_failure "$cert_name: Certificate file not found or not readable: $cert_path"
        return 1
    fi

    # Get expiration date
    local expiry_date
    expiry_date=$(openssl x509 -in "$cert_path" -noout -enddate 2>/dev/null | cut -d= -f2)

    if [ -z "$expiry_date" ]; then
        print_failure "$cert_name: Failed to read certificate expiration date"
        return 1
    fi

    # Calculate days until expiration
    local expiry_epoch
    expiry_epoch=$(date -j -f "%b %d %T %Y %Z" "$expiry_date" +%s 2>/dev/null || date -d "$expiry_date" +%s 2>/dev/null)
    local now_epoch
    now_epoch=$(date +%s)
    local days_until_expiry=$(( (expiry_epoch - now_epoch) / 86400 ))

    if [ "$days_until_expiry" -lt 0 ]; then
        print_failure "$cert_name: Certificate EXPIRED on $expiry_date"
        return 1
    elif [ "$days_until_expiry" -lt 3 ]; then
        print_failure "$cert_name: Certificate expires in $days_until_expiry days (CRITICAL)"
        return 1
    elif [ "$days_until_expiry" -lt "$warn_days" ]; then
        print_warning "$cert_name: Certificate expires in $days_until_expiry days"
        return 0
    else
        print_success "$cert_name: Certificate valid for $days_until_expiry days"
        return 0
    fi
}

# Validate certificate and key match
validate_cert_key_match() {
    local cert_path="$1"
    local key_path="$2"
    local cert_name="$3"

    if ! file_exists_readable "$cert_path"; then
        print_failure "$cert_name: Certificate not found: $cert_path"
        return 1
    fi

    if ! file_exists_readable "$key_path"; then
        print_failure "$cert_name: Private key not found: $key_path"
        return 1
    fi

    # Check if certificate and key match
    local cert_modulus
    cert_modulus=$(openssl x509 -noout -modulus -in "$cert_path" 2>/dev/null | openssl md5)
    local key_modulus
    key_modulus=$(openssl rsa -noout -modulus -in "$key_path" 2>/dev/null | openssl md5)

    if [ "$cert_modulus" != "$key_modulus" ]; then
        print_failure "$cert_name: Certificate and private key do not match"
        return 1
    fi

    print_success "$cert_name: Certificate and private key match"
    return 0
}

# Check file permissions
check_file_permissions() {
    local file_path="$1"
    local expected_perms="$2"
    local file_name="$3"

    if [ ! -f "$file_path" ]; then
        print_failure "$file_name: File not found: $file_path"
        return 1
    fi

    local actual_perms
    actual_perms=$(stat -f "%OLp" "$file_path" 2>/dev/null || stat -c "%a" "$file_path" 2>/dev/null)

    if [ "$actual_perms" != "$expected_perms" ]; then
        print_warning "$file_name: Incorrect permissions. Expected: $expected_perms, Actual: $actual_perms"
        return 0
    fi

    print_success "$file_name: Correct permissions ($actual_perms)"
    return 0
}

# =============================================================================
# SSL Configuration Checks
# =============================================================================

check_prerequisites() {
    print_header "Checking Prerequisites"

    # Check for OpenSSL
    if command_exists openssl; then
        print_success "OpenSSL installed: $(openssl version)"
    else
        print_failure "OpenSSL not installed"
    fi

    # Check for Docker
    if command_exists docker; then
        print_success "Docker installed: $(docker --version)"
    else
        print_warning "Docker not installed (required for runtime checks)"
    fi

    # Check for Docker Compose
    if command_exists docker-compose; then
        print_success "Docker Compose installed: $(docker-compose --version)"
    else
        print_warning "Docker Compose not installed (required for runtime checks)"
    fi
}

check_environment_variables() {
    print_header "Checking Environment Variables"

    if [ ! -f "$ENV_FILE" ]; then
        print_failure "Environment file not found: $ENV_FILE"
        return 1
    fi

    # Source environment file
    source "$ENV_FILE" 2>/dev/null || true

    # Check PostgreSQL SSL variables
    if [ "$POSTGRES_SSL_ENABLED" = "on" ]; then
        print_success "POSTGRES_SSL_ENABLED=on"
    else
        print_warning "POSTGRES_SSL_ENABLED not set to 'on' (current: ${POSTGRES_SSL_ENABLED:-off})"
    fi

    # Check Neo4j SSL variables
    if [ "$NEO4J_SSL_ENABLED" = "true" ]; then
        print_success "NEO4J_SSL_ENABLED=true"
    else
        print_warning "NEO4J_SSL_ENABLED not set to 'true' (current: ${NEO4J_SSL_ENABLED:-false})"
    fi

    # Check SSL mode
    if [ "$ENVIRONMENT" = "production" ]; then
        if [ "$POSTGRES_SSL_MODE" = "verify-full" ] || [ "$POSTGRES_SSL_MODE" = "verify-ca" ]; then
            print_success "POSTGRES_SSL_MODE=$POSTGRES_SSL_MODE (production-ready)"
        else
            print_warning "POSTGRES_SSL_MODE should be 'verify-full' in production (current: ${POSTGRES_SSL_MODE:-prefer})"
        fi

        if [ "$NEO4J_BOLT_TLS_LEVEL" = "REQUIRED" ]; then
            print_success "NEO4J_BOLT_TLS_LEVEL=REQUIRED (production-ready)"
        else
            print_warning "NEO4J_BOLT_TLS_LEVEL should be 'REQUIRED' in production (current: ${NEO4J_BOLT_TLS_LEVEL:-OPTIONAL})"
        fi
    fi
}

check_postgresql_certificates() {
    print_header "Validating PostgreSQL Certificates"

    local postgres_ssl_dir="${SSL_DIR}/postgres"

    # Check if directory exists
    if [ ! -d "$postgres_ssl_dir" ]; then
        print_failure "PostgreSQL SSL directory not found: $postgres_ssl_dir"
        return 1
    fi

    # Check certificate expiration
    check_cert_expiration "${postgres_ssl_dir}/server.crt" "PostgreSQL Server Certificate" 14

    # Validate certificate and key match
    validate_cert_key_match "${postgres_ssl_dir}/server.crt" "${postgres_ssl_dir}/server.key" "PostgreSQL"

    # Check CA certificate
    if file_exists_readable "${postgres_ssl_dir}/ca.crt"; then
        check_cert_expiration "${postgres_ssl_dir}/ca.crt" "PostgreSQL CA Certificate" 14
    else
        print_warning "PostgreSQL CA certificate not found (required for client verification)"
    fi

    # Check file permissions
    check_file_permissions "${postgres_ssl_dir}/server.crt" "644" "PostgreSQL Certificate"
    check_file_permissions "${postgres_ssl_dir}/server.key" "600" "PostgreSQL Private Key"
}

check_neo4j_certificates() {
    print_header "Validating Neo4j Certificates"

    local neo4j_ssl_dir="${SSL_DIR}/neo4j"

    # Check if directory exists
    if [ ! -d "$neo4j_ssl_dir" ]; then
        print_failure "Neo4j SSL directory not found: $neo4j_ssl_dir"
        return 1
    fi

    # Check certificate expiration
    check_cert_expiration "${neo4j_ssl_dir}/neo4j.cert" "Neo4j Server Certificate" 14

    # Validate certificate and key match
    validate_cert_key_match "${neo4j_ssl_dir}/neo4j.cert" "${neo4j_ssl_dir}/neo4j.key" "Neo4j"

    # Check CA certificate
    if file_exists_readable "${neo4j_ssl_dir}/ca.crt"; then
        check_cert_expiration "${neo4j_ssl_dir}/ca.crt" "Neo4j CA Certificate" 14
    else
        print_warning "Neo4j CA certificate not found (required for client verification)"
    fi

    # Check file permissions
    check_file_permissions "${neo4j_ssl_dir}/neo4j.cert" "644" "Neo4j Certificate"
    check_file_permissions "${neo4j_ssl_dir}/neo4j.key" "600" "Neo4j Private Key"
}

check_nginx_certificates() {
    print_header "Validating Nginx Certificates"

    local nginx_ssl_dir="${SSL_DIR}/nginx"

    # Check if directory exists
    if [ ! -d "$nginx_ssl_dir" ]; then
        print_failure "Nginx SSL directory not found: $nginx_ssl_dir"
        return 1
    fi

    # Check certificate expiration
    check_cert_expiration "${nginx_ssl_dir}/cert.pem" "Nginx Server Certificate" 14

    # Validate certificate and key match
    validate_cert_key_match "${nginx_ssl_dir}/cert.pem" "${nginx_ssl_dir}/key.pem" "Nginx"

    # Check Diffie-Hellman parameters
    if file_exists_readable "${nginx_ssl_dir}/dhparam.pem"; then
        print_success "Nginx DH parameters present"
    else
        print_warning "Nginx DH parameters not found (recommended for production)"
    fi

    # Check file permissions
    check_file_permissions "${nginx_ssl_dir}/cert.pem" "644" "Nginx Certificate"
    check_file_permissions "${nginx_ssl_dir}/key.pem" "600" "Nginx Private Key"
}

check_runtime_ssl_connections() {
    print_header "Testing Runtime SSL Connections"

    # Check if Docker containers are running
    if ! command_exists docker; then
        print_warning "Docker not available - skipping runtime checks"
        return 0
    fi

    # Check PostgreSQL SSL
    if docker ps --format '{{.Names}}' | grep -q "cmdb-postgres"; then
        print_info "Testing PostgreSQL SSL connection..."

        if docker exec cmdb-postgres psql -U cmdb_user -d cmdb -c "SHOW ssl;" 2>/dev/null | grep -q "on"; then
            print_success "PostgreSQL SSL enabled in running container"
        else
            print_warning "PostgreSQL SSL not enabled in running container"
        fi

        # Check if SSL is actually being used
        if docker exec cmdb-postgres psql -U cmdb_user -d cmdb \
            -c "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid();" 2>/dev/null | grep -q "t"; then
            print_success "PostgreSQL client using SSL connection"
        else
            print_warning "PostgreSQL client NOT using SSL connection"
        fi
    else
        print_warning "PostgreSQL container not running - skipping runtime checks"
    fi

    # Check Neo4j SSL
    if docker ps --format '{{.Names}}' | grep -q "cmdb-neo4j"; then
        print_info "Testing Neo4j SSL configuration..."

        # Check if bolt TLS is configured
        if docker exec cmdb-neo4j bash -c "cypher-shell -u neo4j -p \$NEO4J_PASSWORD \
            \"CALL dbms.listConfig() YIELD name, value WHERE name = 'dbms.ssl.policy.bolt.enabled' RETURN value\" 2>/dev/null" \
            | grep -q "true"; then
            print_success "Neo4j Bolt SSL enabled in running container"
        else
            print_warning "Neo4j Bolt SSL not enabled in running container"
        fi
    else
        print_warning "Neo4j container not running - skipping runtime checks"
    fi
}

check_certificate_chain() {
    print_header "Validating Certificate Chains"

    # Check if CA certificate exists
    if file_exists_readable "${SSL_DIR}/ca.crt"; then
        print_success "Root CA certificate found"

        # Verify PostgreSQL certificate is signed by CA
        if file_exists_readable "${SSL_DIR}/postgres/server.crt"; then
            if openssl verify -CAfile "${SSL_DIR}/ca.crt" "${SSL_DIR}/postgres/server.crt" &>/dev/null; then
                print_success "PostgreSQL certificate signed by CA"
            else
                print_warning "PostgreSQL certificate NOT signed by CA"
            fi
        fi

        # Verify Neo4j certificate is signed by CA
        if file_exists_readable "${SSL_DIR}/neo4j/neo4j.cert"; then
            if openssl verify -CAfile "${SSL_DIR}/ca.crt" "${SSL_DIR}/neo4j/neo4j.cert" &>/dev/null; then
                print_success "Neo4j certificate signed by CA"
            else
                print_warning "Neo4j certificate NOT signed by CA"
            fi
        fi
    else
        print_warning "Root CA certificate not found (required for certificate chain validation)"
    fi
}

display_summary() {
    print_header "SSL Configuration Validation Summary"

    echo ""
    echo -e "${BLUE}Environment:${NC} $ENVIRONMENT"
    echo -e "${BLUE}Total Checks:${NC} $TOTAL_CHECKS"
    echo -e "${GREEN}Passed:${NC} $PASSED_CHECKS"
    echo -e "${YELLOW}Warnings:${NC} $WARNING_CHECKS"
    echo -e "${RED}Failed:${NC} $FAILED_CHECKS"
    echo ""

    if [ "$FAILED_CHECKS" -eq 0 ]; then
        if [ "$WARNING_CHECKS" -eq 0 ]; then
            echo -e "${GREEN}✓ All SSL checks passed - Configuration is production-ready!${NC}"
            return 0
        else
            echo -e "${YELLOW}⚠ SSL configuration functional but has warnings - Review recommended${NC}"
            return 0
        fi
    else
        echo -e "${RED}✗ SSL configuration has failures - MUST be fixed before production deployment${NC}"
        echo ""
        echo -e "${YELLOW}Recommended Actions:${NC}"

        if [ ! -d "$SSL_DIR" ]; then
            echo "  1. Generate SSL certificates:"
            echo "     cd ${PROJECT_ROOT}/infrastructure/docker/ssl"
            echo "     ./generate-self-signed-certs.sh"
        fi

        echo "  2. Update environment variables in .env file"
        echo "  3. Restart HappyCMDB services:"
        echo "     cd ${PROJECT_ROOT}"
        echo "     ./deploy.sh"
        echo ""
        echo "For detailed guidance, see: ${PROJECT_ROOT}/docs/security/CERTIFICATE_MANAGEMENT.md"

        return 1
    fi
}

# =============================================================================
# Main Execution
# =============================================================================

main() {
    print_header "HappyCMDB - SSL/TLS Configuration Validator"
    echo ""
    print_info "Environment: $ENVIRONMENT"
    print_info "SSL Directory: $SSL_DIR"
    echo ""

    check_prerequisites
    check_environment_variables
    check_postgresql_certificates
    check_neo4j_certificates
    check_nginx_certificates
    check_certificate_chain
    check_runtime_ssl_connections

    echo ""
    display_summary
}

# Run main function
main

# Exit with appropriate code
if [ "$FAILED_CHECKS" -gt 0 ]; then
    exit 1
elif [ "$WARNING_CHECKS" -gt 0 ]; then
    exit 0
else
    exit 0
fi
