#!/bin/bash

###############################################################################
# Dependency Vulnerability Scanner
#
# Scans npm dependencies for known vulnerabilities:
# - npm audit (built-in)
# - Snyk (comprehensive vulnerability database)
# - OWASP Dependency-Check (optional)
#
# Usage:
#   ./security-scan-dependencies.sh [package-path]
#
# Examples:
#   ./security-scan-dependencies.sh packages/api-server
#   ./security-scan-dependencies.sh all  # Scan all packages
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

# Packages to scan
PACKAGES=(
  "packages/common"
  "packages/database"
  "packages/api-server"
  "packages/discovery-engine"
  "packages/etl-processor"
  "packages/agent"
  "packages/cli"
  "web-ui"
  "doc-site"
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
# NPM Audit Scanner
###############################################################################

scan_with_npm_audit() {
  local package_path=$1
  local package_name=$(basename "$package_path")
  local output_file="${SCAN_RESULTS_DIR}/npm-audit_${package_name}_${TIMESTAMP}.json"

  print_header "NPM Audit: $package_name"

  cd "$PROJECT_ROOT/$package_path"

  # Check if package.json exists
  if [ ! -f "package.json" ]; then
    print_warning "No package.json found in $package_path"
    return 0
  fi

  # Run npm audit with JSON output
  if npm audit --json > "$output_file" 2>&1; then
    print_success "No vulnerabilities found"
    return 0
  else
    # Parse audit results
    local critical=$(jq '.metadata.vulnerabilities.critical // 0' "$output_file" 2>/dev/null || echo "0")
    local high=$(jq '.metadata.vulnerabilities.high // 0' "$output_file" 2>/dev/null || echo "0")
    local moderate=$(jq '.metadata.vulnerabilities.moderate // 0' "$output_file" 2>/dev/null || echo "0")
    local low=$(jq '.metadata.vulnerabilities.low // 0' "$output_file" 2>/dev/null || echo "0")

    echo ""
    echo "NPM Audit Results for $package_name:"
    echo "  CRITICAL: $critical"
    echo "  HIGH:     $high"
    echo "  MODERATE: $moderate"
    echo "  LOW:      $low"
    echo ""

    # Generate human-readable report
    npm audit > "${output_file%.json}.txt" 2>&1 || true

    # Fail on critical or high vulnerabilities
    if [ "$critical" -gt 0 ] || [ "$high" -gt 0 ]; then
      print_error "Found $critical CRITICAL and $high HIGH vulnerabilities"

      # Show fixable vulnerabilities
      echo ""
      echo "Attempting automatic fix with 'npm audit fix'..."
      npm audit fix --dry-run || true

      return 1
    else
      print_warning "Found $moderate MODERATE and $low LOW vulnerabilities"
      return 0
    fi
  fi
}

###############################################################################
# Snyk Scanner
###############################################################################

scan_with_snyk() {
  local package_path=$1
  local package_name=$(basename "$package_path")
  local output_file="${SCAN_RESULTS_DIR}/snyk_${package_name}_${TIMESTAMP}.json"

  print_header "Snyk Test: $package_name"

  if ! check_tool snyk; then
    print_warning "Snyk not installed. Install with: npm install -g snyk"
    return 0
  fi

  # Check if authenticated
  if ! snyk auth status &> /dev/null; then
    print_warning "Snyk not authenticated. Run 'snyk auth' first."
    return 0
  fi

  cd "$PROJECT_ROOT/$package_path"

  # Check if package.json exists
  if [ ! -f "package.json" ]; then
    print_warning "No package.json found in $package_path"
    return 0
  fi

  # Run Snyk test
  if snyk test \
    --severity-threshold=high \
    --json \
    --json-file-output="$output_file"; then

    print_success "No vulnerabilities found"
    return 0
  else
    # Parse results
    local critical=$(jq '[.vulnerabilities[] | select(.severity == "critical")] | length' "$output_file" 2>/dev/null || echo "0")
    local high=$(jq '[.vulnerabilities[] | select(.severity == "high")] | length' "$output_file" 2>/dev/null || echo "0")

    echo ""
    echo "Snyk Results for $package_name:"
    echo "  CRITICAL: $critical"
    echo "  HIGH:     $high"
    echo ""

    # Generate human-readable report
    snyk test --severity-threshold=high > "${output_file%.json}.txt" 2>&1 || true

    print_error "Found vulnerabilities (see report for details)"
    return 1
  fi
}

###############################################################################
# License Compliance Check
###############################################################################

check_licenses() {
  local package_path=$1
  local package_name=$(basename "$package_path")
  local output_file="${SCAN_RESULTS_DIR}/licenses_${package_name}_${TIMESTAMP}.json"

  print_header "License Check: $package_name"

  cd "$PROJECT_ROOT/$package_path"

  # Check if package.json exists
  if [ ! -f "package.json" ]; then
    print_warning "No package.json found in $package_path"
    return 0
  fi

  # Install license-checker if not available
  if ! npm list -g license-checker &> /dev/null; then
    print_warning "license-checker not installed. Install with: npm install -g license-checker"
    return 0
  fi

  # Run license checker
  license-checker --json > "$output_file" 2>&1 || true

  # Check for problematic licenses (GPL, AGPL)
  local problematic_licenses=$(jq -r 'to_entries[] | select(.value.licenses | contains("GPL") or contains("AGPL")) | .key' "$output_file" 2>/dev/null || echo "")

  if [ -n "$problematic_licenses" ]; then
    print_warning "Found packages with GPL/AGPL licenses:"
    echo "$problematic_licenses"
    echo ""
    echo "Review these licenses for compatibility with your project."
    return 1
  else
    print_success "No problematic licenses found"
    return 0
  fi
}

###############################################################################
# Outdated Dependencies Check
###############################################################################

check_outdated() {
  local package_path=$1
  local package_name=$(basename "$package_path")
  local output_file="${SCAN_RESULTS_DIR}/outdated_${package_name}_${TIMESTAMP}.json"

  print_header "Outdated Dependencies: $package_name"

  cd "$PROJECT_ROOT/$package_path"

  # Check if package.json exists
  if [ ! -f "package.json" ]; then
    print_warning "No package.json found in $package_path"
    return 0
  fi

  # Check for outdated packages
  if npm outdated --json > "$output_file" 2>&1; then
    print_success "All dependencies up to date"
    return 0
  else
    local outdated_count=$(jq 'keys | length' "$output_file" 2>/dev/null || echo "0")

    if [ "$outdated_count" -gt 0 ]; then
      print_warning "Found $outdated_count outdated packages"

      # Generate human-readable report
      npm outdated > "${output_file%.json}.txt" 2>&1 || true

      # Show first few outdated packages
      echo ""
      echo "Sample of outdated packages:"
      npm outdated 2>&1 | head -n 10 || true

      return 1
    else
      print_success "All dependencies up to date"
      return 0
    fi
  fi
}

###############################################################################
# Main Scanning Logic
###############################################################################

scan_package() {
  local package_path=$1
  local package_name=$(basename "$package_path")
  local npm_audit_result=0
  local snyk_result=0
  local license_result=0
  local outdated_result=0

  echo ""
  print_header "Scanning Package: $package_name"

  # Check if package directory exists
  if [ ! -d "$PROJECT_ROOT/$package_path" ]; then
    print_error "Package directory not found: $package_path"
    return 1
  fi

  # Run all scanners
  scan_with_npm_audit "$package_path" || npm_audit_result=$?
  scan_with_snyk "$package_path" || snyk_result=$?
  check_licenses "$package_path" || license_result=$?
  check_outdated "$package_path" || outdated_result=$?

  # Summary
  echo ""
  print_header "Summary for $package_name"
  if [ $npm_audit_result -eq 0 ] && [ $snyk_result -eq 0 ] && [ $license_result -eq 0 ]; then
    print_success "All security checks passed"
    if [ $outdated_result -ne 0 ]; then
      print_warning "Some dependencies are outdated (not a security issue)"
    fi
    return 0
  else
    print_error "Some security checks failed"
    echo "  NPM Audit:  $([ $npm_audit_result -eq 0 ] && echo 'PASS' || echo 'FAIL')"
    echo "  Snyk:       $([ $snyk_result -eq 0 ] && echo 'PASS' || echo 'FAIL')"
    echo "  Licenses:   $([ $license_result -eq 0 ] && echo 'PASS' || echo 'FAIL')"
    echo "  Outdated:   $([ $outdated_result -eq 0 ] && echo 'PASS' || echo 'FAIL')"
    return 1
  fi
}

###############################################################################
# Entry Point
###############################################################################

main() {
  # Create results directory
  mkdir -p "$SCAN_RESULTS_DIR"

  print_header "HappyCMDB Dependency Security Scanner"
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
      print_success "All packages passed security scans!"
      exit 0
    else
      print_error "The following packages failed security scans:"
      for package in "${failed_packages[@]}"; do
        echo "  - $package"
      done
      echo ""
      echo "To fix vulnerabilities automatically, run:"
      echo "  npm audit fix"
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
