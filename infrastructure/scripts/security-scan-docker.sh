#!/bin/bash

###############################################################################
# Docker Image Security Scanner
#
# Scans Docker images for vulnerabilities using multiple tools:
# - Trivy (comprehensive vulnerability scanner)
# - Grype (Anchore's vulnerability scanner)
# - Snyk (commercial scanner with free tier)
#
# Usage:
#   ./security-scan-docker.sh [image-name]
#
# Examples:
#   ./security-scan-docker.sh cmdb-api-server:latest
#   ./security-scan-docker.sh all  # Scan all HappyCMDB images
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
SEVERITY_THRESHOLD="HIGH"  # Fail on HIGH or CRITICAL

# HappyCMDB images to scan
HAPPYCMDB_IMAGES=(
  "cmdb-api-server:latest"
  "cmdb-web-ui:latest"
  "cmdb-discovery-engine:latest"
  "cmdb-etl-processor:latest"
  "cmdb-agent:latest"
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
    print_warning "$tool not found. Install with:"
    case $tool in
      trivy)
        echo "  brew install aquasecurity/trivy/trivy"
        echo "  # OR"
        echo "  curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin"
        ;;
      grype)
        echo "  brew tap anchore/grype && brew install grype"
        echo "  # OR"
        echo "  curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh -s -- -b /usr/local/bin"
        ;;
      snyk)
        echo "  npm install -g snyk"
        echo "  snyk auth  # Authenticate with Snyk account"
        ;;
    esac
    return 1
  fi
  return 0
}

###############################################################################
# Trivy Scanner
###############################################################################

scan_with_trivy() {
  local image=$1
  local output_file="${SCAN_RESULTS_DIR}/trivy_${image//[:\/]/_}_${TIMESTAMP}.json"

  print_header "Scanning $image with Trivy"

  if ! check_tool trivy; then
    print_warning "Skipping Trivy scan"
    return 0
  fi

  # Scan image with JSON output
  if trivy image \
    --severity "${SEVERITY_THRESHOLD},CRITICAL" \
    --format json \
    --output "$output_file" \
    "$image"; then

    # Parse results
    local critical_count=$(jq '[.Results[].Vulnerabilities[] | select(.Severity == "CRITICAL")] | length' "$output_file" 2>/dev/null || echo "0")
    local high_count=$(jq '[.Results[].Vulnerabilities[] | select(.Severity == "HIGH")] | length' "$output_file" 2>/dev/null || echo "0")
    local medium_count=$(jq '[.Results[].Vulnerabilities[] | select(.Severity == "MEDIUM")] | length' "$output_file" 2>/dev/null || echo "0")

    echo ""
    echo "Trivy Scan Results for $image:"
    echo "  CRITICAL: $critical_count"
    echo "  HIGH:     $high_count"
    echo "  MEDIUM:   $medium_count"
    echo ""

    # Generate human-readable report
    trivy image \
      --severity "${SEVERITY_THRESHOLD},CRITICAL" \
      --format table \
      "$image" > "${output_file%.json}.txt"

    if [ "$critical_count" -gt 0 ] || [ "$high_count" -gt 0 ]; then
      print_error "Found $critical_count CRITICAL and $high_count HIGH vulnerabilities"
      return 1
    else
      print_success "No HIGH or CRITICAL vulnerabilities found"
      return 0
    fi
  else
    print_error "Trivy scan failed"
    return 1
  fi
}

###############################################################################
# Grype Scanner
###############################################################################

scan_with_grype() {
  local image=$1
  local output_file="${SCAN_RESULTS_DIR}/grype_${image//[:\/]/_}_${TIMESTAMP}.json"

  print_header "Scanning $image with Grype"

  if ! check_tool grype; then
    print_warning "Skipping Grype scan"
    return 0
  fi

  # Scan image with JSON output
  if grype "$image" \
    --fail-on high \
    --output json \
    --file "$output_file"; then

    # Parse results
    local critical_count=$(jq '[.matches[] | select(.vulnerability.severity == "Critical")] | length' "$output_file" 2>/dev/null || echo "0")
    local high_count=$(jq '[.matches[] | select(.vulnerability.severity == "High")] | length' "$output_file" 2>/dev/null || echo "0")
    local medium_count=$(jq '[.matches[] | select(.vulnerability.severity == "Medium")] | length' "$output_file" 2>/dev/null || echo "0")

    echo ""
    echo "Grype Scan Results for $image:"
    echo "  CRITICAL: $critical_count"
    echo "  HIGH:     $high_count"
    echo "  MEDIUM:   $medium_count"
    echo ""

    # Generate human-readable report
    grype "$image" \
      --output table \
      > "${output_file%.json}.txt"

    if [ "$critical_count" -gt 0 ] || [ "$high_count" -gt 0 ]; then
      print_error "Found $critical_count CRITICAL and $high_count HIGH vulnerabilities"
      return 1
    else
      print_success "No HIGH or CRITICAL vulnerabilities found"
      return 0
    fi
  else
    # Grype returns non-zero if vulnerabilities found
    print_error "Grype scan found vulnerabilities"
    return 1
  fi
}

###############################################################################
# Snyk Scanner
###############################################################################

scan_with_snyk() {
  local image=$1
  local output_file="${SCAN_RESULTS_DIR}/snyk_${image//[:\/]/_}_${TIMESTAMP}.json"

  print_header "Scanning $image with Snyk"

  if ! check_tool snyk; then
    print_warning "Skipping Snyk scan"
    return 0
  fi

  # Check if authenticated
  if ! snyk auth status &> /dev/null; then
    print_warning "Snyk not authenticated. Run 'snyk auth' first."
    return 0
  fi

  # Scan Docker image
  if snyk container test "$image" \
    --severity-threshold=high \
    --json \
    --json-file-output="$output_file"; then

    # Generate human-readable report
    snyk container test "$image" \
      --severity-threshold=high \
      > "${output_file%.json}.txt" || true

    print_success "Snyk scan passed"
    return 0
  else
    print_error "Snyk scan found vulnerabilities"

    # Generate human-readable report even on failure
    snyk container test "$image" \
      --severity-threshold=high \
      > "${output_file%.json}.txt" || true

    return 1
  fi
}

###############################################################################
# Main Scanning Logic
###############################################################################

scan_image() {
  local image=$1
  local trivy_result=0
  local grype_result=0
  local snyk_result=0

  echo ""
  print_header "Scanning Image: $image"

  # Check if image exists locally
  if ! docker image inspect "$image" &> /dev/null; then
    print_error "Image $image not found locally. Build it first."
    return 1
  fi

  # Run all scanners
  scan_with_trivy "$image" || trivy_result=$?
  scan_with_grype "$image" || grype_result=$?
  scan_with_snyk "$image" || snyk_result=$?

  # Summary
  echo ""
  print_header "Summary for $image"
  if [ $trivy_result -eq 0 ] && [ $grype_result -eq 0 ] && [ $snyk_result -eq 0 ]; then
    print_success "All scans passed"
    return 0
  else
    print_error "Some scans failed or found vulnerabilities"
    echo "  Trivy:  $([ $trivy_result -eq 0 ] && echo 'PASS' || echo 'FAIL')"
    echo "  Grype:  $([ $grype_result -eq 0 ] && echo 'PASS' || echo 'FAIL')"
    echo "  Snyk:   $([ $snyk_result -eq 0 ] && echo 'PASS' || echo 'FAIL')"
    return 1
  fi
}

###############################################################################
# Entry Point
###############################################################################

main() {
  # Create results directory
  mkdir -p "$SCAN_RESULTS_DIR"

  print_header "HappyCMDB Docker Image Security Scanner"
  echo "Timestamp: $TIMESTAMP"
  echo "Results directory: $SCAN_RESULTS_DIR"
  echo ""

  # Check if specific image provided or scan all
  if [ $# -eq 0 ] || [ "$1" == "all" ]; then
    print_header "Scanning all HappyCMDB images"

    local failed_images=()
    for image in "${HAPPYCMDB_IMAGES[@]}"; do
      if ! scan_image "$image"; then
        failed_images+=("$image")
      fi
    done

    # Final summary
    echo ""
    print_header "Final Summary"
    if [ ${#failed_images[@]} -eq 0 ]; then
      print_success "All images passed security scans!"
      exit 0
    else
      print_error "The following images failed security scans:"
      for image in "${failed_images[@]}"; do
        echo "  - $image"
      done
      exit 1
    fi
  else
    # Scan specific image
    scan_image "$1"
    exit $?
  fi
}

# Run main function
main "$@"
