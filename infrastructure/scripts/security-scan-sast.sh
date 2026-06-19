#!/bin/bash

###############################################################################
# Static Application Security Testing (SAST)
#
# Performs static code analysis to find security vulnerabilities:
# - ESLint with security plugins
# - Semgrep (pattern-based security scanner)
# - TypeScript strict mode checks
#
# Usage:
#   ./security-scan-sast.sh [package-path]
#
# Examples:
#   ./security-scan-sast.sh packages/api-server
#   ./security-scan-sast.sh all  # Scan all TypeScript packages
###############################################################################

set -e  # Exit on error
set -u  # Exit on undefined variable

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCAN_RESULTS_DIR="./security-scan-results"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Packages to scan (TypeScript only)
PACKAGES=(
  "packages/common"
  "packages/database"
  "packages/api-server"
  "packages/discovery-engine"
  "packages/etl-processor"
  "packages/agent"
  "packages/cli"
)

###############################################################################
# Helper Functions
###############################################################################

print_header() {
  echo -e "${BLUE}======================================${NC}"
  echo -e "${BLUE}$1${NC}"
  echo -e "${BLUE}======================================${NC}"
}

print_success() {
  echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
  echo -e "${RED}✗ $1${NC}"
}

print_warning() {
  echo -e "${YELLOW}⚠ $1${NC}"
}

check_tool() {
  local tool=$1
  if ! command -v "$tool" &> /dev/null; then
    return 1
  fi
  return 0
}

###############################################################################
# ESLint Security Scanner
###############################################################################

scan_with_eslint() {
  local package_path=$1
  local package_name=$(basename "$package_path")
  local output_file="${SCAN_RESULTS_DIR}/eslint_${package_name}_${TIMESTAMP}.json"

  print_header "ESLint Security: $package_name"

  cd "$PROJECT_ROOT/$package_path"

  # Check if TypeScript files exist
  if ! find src -name "*.ts" -o -name "*.tsx" 2>/dev/null | grep -q .; then
    print_warning "No TypeScript files found in $package_path"
    return 0
  fi

  # Check if ESLint is installed
  if [ ! -f "../../node_modules/.bin/eslint" ]; then
    print_warning "ESLint not installed. Run 'npm install' at project root."
    return 0
  fi

  # Run ESLint with security rules
  if ../../node_modules/.bin/eslint \
    --ext .ts,.tsx \
    --format json \
    --output-file "$output_file" \
    src/ 2>&1; then

    print_success "No ESLint errors found"
    return 0
  else
    # Parse results
    local error_count=$(jq '[.[] | .errorCount] | add // 0' "$output_file" 2>/dev/null || echo "0")
    local warning_count=$(jq '[.[] | .warningCount] | add // 0' "$output_file" 2>/dev/null || echo "0")

    echo ""
    echo "ESLint Results for $package_name:"
    echo "  ERRORS:   $error_count"
    echo "  WARNINGS: $warning_count"
    echo ""

    # Generate human-readable report
    ../../node_modules/.bin/eslint \
      --ext .ts,.tsx \
      src/ > "${output_file%.json}.txt" 2>&1 || true

    # Show sample issues
    if [ "$error_count" -gt 0 ]; then
      echo "Sample errors:"
      jq -r '.[].messages[] | select(.severity == 2) | "  \(.ruleId): \(.message) (\(.line):\(.column))"' "$output_file" 2>/dev/null | head -n 5 || true
      echo ""
    fi

    if [ "$error_count" -gt 0 ]; then
      print_error "Found $error_count ESLint errors"
      return 1
    else
      print_warning "Found $warning_count ESLint warnings"
      return 0
    fi
  fi
}

###############################################################################
# Semgrep Security Scanner
###############################################################################

scan_with_semgrep() {
  local package_path=$1
  local package_name=$(basename "$package_path")
  local output_file="${SCAN_RESULTS_DIR}/semgrep_${package_name}_${TIMESTAMP}.json"

  print_header "Semgrep Security: $package_name"

  if ! check_tool semgrep; then
    print_warning "Semgrep not installed. Install with: pip install semgrep"
    return 0
  fi

  cd "$PROJECT_ROOT/$package_path"

  # Check if source directory exists
  if [ ! -d "src" ]; then
    print_warning "No src directory found in $package_path"
    return 0
  fi

  # Run Semgrep with security rules
  if semgrep \
    --config auto \
    --severity ERROR \
    --json \
    --output "$output_file" \
    src/ 2>&1; then

    local finding_count=$(jq '.results | length' "$output_file" 2>/dev/null || echo "0")

    if [ "$finding_count" -eq 0 ]; then
      print_success "No security issues found"
      return 0
    else
      echo ""
      echo "Semgrep Results for $package_name:"
      echo "  FINDINGS: $finding_count"
      echo ""

      # Generate human-readable report
      semgrep \
        --config auto \
        --severity ERROR \
        src/ > "${output_file%.json}.txt" 2>&1 || true

      # Show sample findings
      echo "Sample findings:"
      jq -r '.results[] | "  \(.check_id): \(.extra.message) (\(.path):\(.start.line))"' "$output_file" 2>/dev/null | head -n 5 || true
      echo ""

      print_error "Found $finding_count security issues"
      return 1
    fi
  else
    print_error "Semgrep scan failed"
    return 1
  fi
}

###############################################################################
# TypeScript Strict Mode Check
###############################################################################

check_typescript_strict() {
  local package_path=$1
  local package_name=$(basename "$package_path")

  print_header "TypeScript Strict Mode: $package_name"

  cd "$PROJECT_ROOT/$package_path"

  # Check if tsconfig.json exists
  if [ ! -f "tsconfig.json" ]; then
    print_warning "No tsconfig.json found in $package_path"
    return 0
  fi

  # Check if strict mode is enabled
  local strict_enabled=$(jq -r '.compilerOptions.strict // false' tsconfig.json 2>/dev/null)

  if [ "$strict_enabled" == "true" ]; then
    print_success "TypeScript strict mode enabled"

    # Check for additional strict flags
    local strict_null_checks=$(jq -r '.compilerOptions.strictNullChecks // false' tsconfig.json 2>/dev/null)
    local no_implicit_any=$(jq -r '.compilerOptions.noImplicitAny // false' tsconfig.json 2>/dev/null)
    local strict_function_types=$(jq -r '.compilerOptions.strictFunctionTypes // false' tsconfig.json 2>/dev/null)

    echo "  strictNullChecks:      $strict_null_checks"
    echo "  noImplicitAny:         $no_implicit_any"
    echo "  strictFunctionTypes:   $strict_function_types"

    return 0
  else
    print_warning "TypeScript strict mode NOT enabled"
    echo "  Enable strict mode in tsconfig.json for better type safety"
    return 1
  fi
}

###############################################################################
# Secret Detection
###############################################################################

scan_for_secrets() {
  local package_path=$1
  local package_name=$(basename "$package_path")
  local output_file="${SCAN_RESULTS_DIR}/secrets_${package_name}_${TIMESTAMP}.txt"

  print_header "Secret Detection: $package_name"

  cd "$PROJECT_ROOT/$package_path"

  # Check if source directory exists
  if [ ! -d "src" ]; then
    print_warning "No src directory found in $package_path"
    return 0
  fi

  # Common patterns for secrets
  local patterns=(
    "password\s*=\s*['\"][^'\"]+['\"]"
    "api[_-]?key\s*=\s*['\"][^'\"]+['\"]"
    "secret\s*=\s*['\"][^'\"]+['\"]"
    "token\s*=\s*['\"][^'\"]+['\"]"
    "aws[_-]?access[_-]?key"
    "private[_-]?key"
    "['\"][a-zA-Z0-9]{32,}['\"]"  # Long random strings
  )

  local findings=0

  for pattern in "${patterns[@]}"; do
    if grep -rn -E -i "$pattern" src/ > /dev/null 2>&1; then
      if [ $findings -eq 0 ]; then
        echo "Potential secrets found:" > "$output_file"
      fi
      grep -rn -E -i "$pattern" src/ >> "$output_file" 2>&1 || true
      findings=$((findings + 1))
    fi
  done

  if [ $findings -gt 0 ]; then
    print_warning "Found potential secrets in code"
    echo "  Review: $output_file"
    echo ""
    echo "Sample findings:"
    head -n 5 "$output_file"
    return 1
  else
    print_success "No hardcoded secrets detected"
    return 0
  fi
}

###############################################################################
# Common Vulnerability Patterns
###############################################################################

scan_vulnerability_patterns() {
  local package_path=$1
  local package_name=$(basename "$package_path")
  local output_file="${SCAN_RESULTS_DIR}/patterns_${package_name}_${TIMESTAMP}.txt"

  print_header "Vulnerability Patterns: $package_name"

  cd "$PROJECT_ROOT/$package_path"

  # Check if source directory exists
  if [ ! -d "src" ]; then
    print_warning "No src directory found in $package_path"
    return 0
  fi

  local findings=0

  # Check for eval() usage
  if grep -rn "eval(" src/ > /dev/null 2>&1; then
    echo "DANGER: eval() usage found:" >> "$output_file"
    grep -rn "eval(" src/ >> "$output_file" 2>&1 || true
    findings=$((findings + 1))
  fi

  # Check for exec() usage
  if grep -rn "exec(" src/ > /dev/null 2>&1; then
    echo "DANGER: exec() usage found:" >> "$output_file"
    grep -rn "exec(" src/ >> "$output_file" 2>&1 || true
    findings=$((findings + 1))
  fi

  # Check for innerHTML usage
  if grep -rn "innerHTML" src/ > /dev/null 2>&1; then
    echo "WARNING: innerHTML usage found (potential XSS):" >> "$output_file"
    grep -rn "innerHTML" src/ >> "$output_file" 2>&1 || true
    findings=$((findings + 1))
  fi

  # Check for SQL string concatenation
  if grep -rn "SELECT.*+\|INSERT.*+\|UPDATE.*+\|DELETE.*+" src/ > /dev/null 2>&1; then
    echo "WARNING: Potential SQL injection (string concatenation):" >> "$output_file"
    grep -rn "SELECT.*+\|INSERT.*+\|UPDATE.*+\|DELETE.*+" src/ >> "$output_file" 2>&1 || true
    findings=$((findings + 1))
  fi

  # Check for unsafe randomness
  if grep -rn "Math.random()" src/ > /dev/null 2>&1; then
    echo "WARNING: Math.random() used (not cryptographically secure):" >> "$output_file"
    grep -rn "Math.random()" src/ >> "$output_file" 2>&1 || true
    findings=$((findings + 1))
  fi

  if [ $findings -gt 0 ]; then
    print_warning "Found $findings vulnerability patterns"
    echo "  Review: $output_file"
    echo ""
    echo "Sample findings:"
    head -n 10 "$output_file"
    return 1
  else
    print_success "No dangerous patterns detected"
    return 0
  fi
}

###############################################################################
# Main Scanning Logic
###############################################################################

scan_package() {
  local package_path=$1
  local package_name=$(basename "$package_path")
  local eslint_result=0
  local semgrep_result=0
  local typescript_result=0
  local secrets_result=0
  local patterns_result=0

  echo ""
  print_header "SAST Scan: $package_name"

  # Check if package directory exists
  if [ ! -d "$PROJECT_ROOT/$package_path" ]; then
    print_error "Package directory not found: $package_path"
    return 1
  fi

  # Run all scanners
  scan_with_eslint "$package_path" || eslint_result=$?
  scan_with_semgrep "$package_path" || semgrep_result=$?
  check_typescript_strict "$package_path" || typescript_result=$?
  scan_for_secrets "$package_path" || secrets_result=$?
  scan_vulnerability_patterns "$package_path" || patterns_result=$?

  # Summary
  echo ""
  print_header "Summary for $package_name"

  local failed=0
  if [ $eslint_result -ne 0 ]; then failed=$((failed + 1)); fi
  if [ $semgrep_result -ne 0 ]; then failed=$((failed + 1)); fi
  if [ $secrets_result -ne 0 ]; then failed=$((failed + 1)); fi
  if [ $patterns_result -ne 0 ]; then failed=$((failed + 1)); fi

  echo "  ESLint:            $([ $eslint_result -eq 0 ] && echo 'PASS' || echo 'FAIL')"
  echo "  Semgrep:           $([ $semgrep_result -eq 0 ] && echo 'PASS' || echo 'FAIL')"
  echo "  TypeScript Strict: $([ $typescript_result -eq 0 ] && echo 'PASS' || echo 'WARN')"
  echo "  Secret Detection:  $([ $secrets_result -eq 0 ] && echo 'PASS' || echo 'FAIL')"
  echo "  Vuln Patterns:     $([ $patterns_result -eq 0 ] && echo 'PASS' || echo 'FAIL')"

  if [ $failed -gt 0 ]; then
    print_error "$failed security checks failed"
    return 1
  else
    print_success "All SAST checks passed"
    return 0
  fi
}

###############################################################################
# Entry Point
###############################################################################

main() {
  # Create results directory
  mkdir -p "$SCAN_RESULTS_DIR"

  print_header "HappyCMDB Static Application Security Testing (SAST)"
  echo "Timestamp: $TIMESTAMP"
  echo "Results directory: $SCAN_RESULTS_DIR"
  echo ""

  # Check if specific package provided or scan all
  if [ $# -eq 0 ] || [ "$1" == "all" ]; then
    print_header "Scanning all packages"

    local failed_packages=()
    for package in "${PACKAGES[@]}"; do
      if ! scan_package "$package"; then
        failed_packages+=("$package")
      fi
    done

    # Final summary
    echo ""
    print_header "Final Summary"
    if [ ${#failed_packages[@]} -eq 0 ]; then
      print_success "All packages passed SAST scans!"
      exit 0
    else
      print_error "The following packages failed SAST scans:"
      for package in "${failed_packages[@]}"; do
        echo "  - $package"
      done
      echo ""
      echo "To see detailed reports, check: $SCAN_RESULTS_DIR"
      exit 1
    fi
  else
    # Scan specific package
    scan_package "$1"
    exit $?
  fi
}

# Run main function
main "$@"
