#!/bin/bash

# =============================================================================
# HappyCMDB - Secret Detection Script
# =============================================================================
# Scans the codebase for hardcoded secrets and sensitive information.
# This script should be run:
# - During CI/CD pipeline (as a pre-commit check)
# - Before deploying to production
# - Periodically as part of security audits
#
# Exit codes:
#   0 = No secrets found
#   1 = Secrets detected (CRITICAL - DO NOT DEPLOY)
#   2 = Script error
# =============================================================================

set -o pipefail

# Colors for output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SECRETS_FOUND=0
WARNINGS_FOUND=0

# Files/directories to exclude
EXCLUDE_PATTERNS=(
  "node_modules"
  "dist"
  ".git"
  ".vitepress"
  "*.min.js"
  "*.map"
  "package-lock.json"
  "yarn.lock"
  "pnpm-lock.yaml"
)

# Build exclude arguments for grep
EXCLUDE_ARGS=""
for pattern in "${EXCLUDE_PATTERNS[@]}"; do
  EXCLUDE_ARGS+=" --exclude-dir=$pattern"
done

echo -e "${BLUE}=============================================${NC}"
echo -e "${BLUE}HappyCMDB - Secret Detection Scanner${NC}"
echo -e "${BLUE}=============================================${NC}"
echo ""
echo "Repository: $REPO_ROOT"
echo "Date: $(date)"
echo ""

# =============================================================================
# Pattern Definitions
# =============================================================================

# CRITICAL: Production secrets (will fail CI/CD)
declare -A CRITICAL_PATTERNS=(
  ["AWS Access Key"]="AKIA[0-9A-Z]{16}"
  ["AWS Secret Key"]="aws_secret_access_key['\"]?\s*[:=]\s*['\"]([A-Za-z0-9/+=]{40})['\"]"
  ["GitHub Token"]="gh[pousr]_[A-Za-z0-9_]{36,255}"
  ["Slack Token"]="xox[baprs]-[0-9]{10,12}-[0-9]{10,12}-[A-Za-z0-9]{24,32}"
  ["OpenAI API Key"]="sk-[A-Za-z0-9]{48}"
  ["Private SSH Key"]="-----BEGIN (RSA|DSA|EC|OPENSSH) PRIVATE KEY-----"
  ["JWT with signature"]="eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"
  ["Azure Storage Key"]="DefaultEndpointsProtocol=https.*AccountKey=[A-Za-z0-9+/=]{88}"
  ["Database URI with password"]="(postgres|mysql|mongodb)://[^:]+:[^@]{8,}@"
)

# HIGH: Likely secrets (will fail CI/CD but may have exceptions)
declare -A HIGH_PATTERNS=(
  ["Hardcoded Password"]="(password|passwd|pwd)['\"]?\s*[:=]\s*['\"]([^'\"]{8,})['\"]"
  ["Hardcoded API Key"]="(api_key|apikey|api-key)['\"]?\s*[:=]\s*['\"]([^'\"]{20,})['\"]"
  ["Hardcoded Secret"]="secret['\"]?\s*[:=]\s*['\"]([^'\"]{20,})['\"]"
  ["Hardcoded Token"]="token['\"]?\s*[:=]\s*['\"]([^'\"]{20,})['\"]"
  ["Base64 Encoded Secret"]="(secret|password|key).*['\"]([A-Za-z0-9+/]{40,}={0,2})['\"]"
)

# MEDIUM: Potential issues (will warn but not fail)
declare -A MEDIUM_PATTERNS=(
  ["Environment Variable Reference"]="process\.env\[(.*?)\]"
  ["Test Password"]="(testpassword|test_password|admin123|Admin123!)"
  ["Default Credentials"]="(neo4j/.*|postgres/.*|admin/admin)"
)

# =============================================================================
# Helper Functions
# =============================================================================

print_finding() {
  local severity=$1
  local pattern_name=$2
  local file=$3
  local line_num=$4
  local line_content=$5

  case $severity in
    "CRITICAL")
      echo -e "${RED}[CRITICAL]${NC} $pattern_name"
      ((SECRETS_FOUND++))
      ;;
    "HIGH")
      echo -e "${RED}[HIGH]${NC} $pattern_name"
      ((SECRETS_FOUND++))
      ;;
    "MEDIUM")
      echo -e "${YELLOW}[MEDIUM]${NC} $pattern_name"
      ((WARNINGS_FOUND++))
      ;;
  esac

  echo "  File: $file:$line_num"
  echo "  Content: ${line_content:0:120}"
  echo ""
}

# =============================================================================
# Scan Functions
# =============================================================================

scan_for_patterns() {
  local severity=$1
  shift
  declare -n patterns=$1

  echo -e "${BLUE}Scanning for $severity severity patterns...${NC}"

  for pattern_name in "${!patterns[@]}"; do
    local pattern="${patterns[$pattern_name]}"

    # Use grep to find matches
    while IFS=: read -r file line_num line_content; do
      # Skip if in excluded directory
      skip=false
      for exclude in "${EXCLUDE_PATTERNS[@]}"; do
        if [[ "$file" == *"$exclude"* ]]; then
          skip=true
          break
        fi
      done

      # Skip .env.example and template files
      if [[ "$file" == *".env.example"* ]] || \
         [[ "$file" == *".env.production.example"* ]] || \
         [[ "$file" == *".env.staging.example"* ]] || \
         [[ "$file" == *"_TEMPLATE"* ]] || \
         [[ "$file" == *"template"* ]]; then
        skip=true
      fi

      # Skip Kubernetes secret templates
      if [[ "$file" == *"kubernetes/secrets"* ]] && [[ "$line_content" == *"CHANGE_ME"* ]]; then
        skip=true
      fi

      # Skip if process.env reference (environment variable, not hardcoded)
      if [[ "$line_content" =~ process\.env\[ ]] || \
         [[ "$line_content" =~ \$\{.*\} ]] || \
         [[ "$line_content" =~ \$[A-Z_]+ ]]; then
        skip=true
      fi

      if [ "$skip" = false ]; then
        print_finding "$severity" "$pattern_name" "$file" "$line_num" "$line_content"
      fi
    done < <(grep -rn -E -I "$pattern" "$REPO_ROOT" $EXCLUDE_ARGS 2>/dev/null || true)
  done
}

# =============================================================================
# Special Checks
# =============================================================================

check_seed_data_script() {
  echo -e "${BLUE}Checking seed data script for hardcoded credentials...${NC}"

  local seed_file="$REPO_ROOT/infrastructure/scripts/seed-data.ts"

  if [ -f "$seed_file" ]; then
    # Check for hardcoded test passwords
    if grep -q "password: 'Admin123!'" "$seed_file"; then
      print_finding "MEDIUM" "Hardcoded test password in seed script" \
        "$seed_file" "28" "password: 'Admin123!'"
    fi

    # Check for hardcoded bcrypt hash
    if grep -q '\$2b\$10\$' "$seed_file"; then
      print_finding "MEDIUM" "Hardcoded bcrypt hash in seed script" \
        "$seed_file" "30" "passwordHash: '\$2b\$...'"
    fi

    # Check for hardcoded database password
    if grep -q "cmdb_password_dev" "$seed_file"; then
      print_finding "HIGH" "Hardcoded database password in seed script" \
        "$seed_file" "22" "NEO4J_PASSWORD = 'cmdb_password_dev'"
    fi
  fi
}

check_login_form() {
  echo -e "${BLUE}Checking login form for hardcoded credentials...${NC}"

  local login_form="$REPO_ROOT/web-ui/src/components/auth/LoginForm.tsx"

  if [ -f "$login_form" ]; then
    if grep -q "password: 'Admin123!'" "$login_form"; then
      print_finding "HIGH" "Hardcoded credentials in login form (dev convenience)" \
        "$login_form" "42-43" "username: 'admin', password: 'Admin123!'"
    fi
  fi
}

check_test_containers() {
  echo -e "${BLUE}Checking test container configurations...${NC}"

  local test_file="$REPO_ROOT/packages/api-server/tests/helpers/test-containers.ts"

  if [ -f "$test_file" ]; then
    if grep -q "testpassword" "$test_file"; then
      print_finding "MEDIUM" "Hardcoded test password in test containers" \
        "$test_file" "Multiple" "NEO4J_AUTH: 'neo4j/testpassword'"
    fi
  fi
}

# =============================================================================
# Main Execution
# =============================================================================

echo "Starting secret scan..."
echo ""

# Run pattern scans
scan_for_patterns "CRITICAL" CRITICAL_PATTERNS
scan_for_patterns "HIGH" HIGH_PATTERNS
scan_for_patterns "MEDIUM" MEDIUM_PATTERNS

# Run special checks
check_seed_data_script
check_login_form
check_test_containers

# =============================================================================
# Summary and Exit
# =============================================================================

echo -e "${BLUE}=============================================${NC}"
echo -e "${BLUE}Scan Complete${NC}"
echo -e "${BLUE}=============================================${NC}"
echo ""

if [ $SECRETS_FOUND -eq 0 ] && [ $WARNINGS_FOUND -eq 0 ]; then
  echo -e "${GREEN}✓ No secrets detected!${NC}"
  exit 0
elif [ $SECRETS_FOUND -eq 0 ]; then
  echo -e "${YELLOW}⚠ Warnings found: $WARNINGS_FOUND${NC}"
  echo -e "${YELLOW}Review warnings but safe to proceed.${NC}"
  exit 0
else
  echo -e "${RED}✗ CRITICAL/HIGH secrets detected: $SECRETS_FOUND${NC}"
  echo -e "${YELLOW}⚠ Warnings: $WARNINGS_FOUND${NC}"
  echo ""
  echo -e "${RED}DO NOT DEPLOY - Fix all CRITICAL and HIGH severity issues!${NC}"
  echo ""
  echo "Remediation steps:"
  echo "1. Replace all hardcoded secrets with environment variables"
  echo "2. Update .env.example with placeholder values"
  echo "3. Rotate any secrets that were committed to Git"
  echo "4. Run: ./infrastructure/scripts/detect-secrets.sh"
  echo ""
  exit 1
fi
