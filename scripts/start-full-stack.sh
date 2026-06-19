#!/bin/bash

###############################################################################
# HappyCMDB Full Stack Startup Script
#
# This script:
# 1. Checks if Docker services are running (Neo4j, PostgreSQL, Redis)
# 2. Builds and starts the API server
# 3. Runs the seed data script to populate test data
# 4. Prints access credentials and URLs for testing
#
# Usage:
#   ./scripts/start-full-stack.sh
#   ./scripts/start-full-stack.sh --no-seed  # Skip seed data
###############################################################################

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Options
SKIP_SEED=false
SKIP_BUILD=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --no-seed)
      SKIP_SEED=true
      shift
      ;;
    --no-build)
      SKIP_BUILD=true
      shift
      ;;
    --help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --no-seed    Skip seed data loading"
      echo "  --no-build   Skip building packages"
      echo "  --help       Show this help message"
      exit 0
      ;;
  esac
done

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}HappyCMDB Full Stack Startup${NC}"
echo -e "${BLUE}=========================================${NC}"
echo ""

###############################################################################
# Step 1: Check Docker Services
###############################################################################

echo -e "${YELLOW}[1/5] Checking Docker services...${NC}"

check_docker_service() {
  local service_name=$1
  local container_name=$2
  local port=$3

  if docker ps | grep -q "$container_name"; then
    echo -e "  ${GREEN}✓${NC} $service_name is running"
    return 0
  else
    echo -e "  ${RED}✗${NC} $service_name is not running"
    return 1
  fi
}

# Check services
DOCKER_OK=true

if ! check_docker_service "Neo4j" "neo4j" "7687"; then
  DOCKER_OK=false
fi

if ! check_docker_service "PostgreSQL" "postgres" "5432"; then
  DOCKER_OK=false
fi

if ! check_docker_service "Redis" "redis" "6379"; then
  DOCKER_OK=false
fi

if [ "$DOCKER_OK" = false ]; then
  echo ""
  echo -e "${RED}ERROR: Required Docker services are not running${NC}"
  echo -e "${YELLOW}Please start services with: docker-compose up -d${NC}"
  exit 1
fi

echo -e "${GREEN}All Docker services are running${NC}"
echo ""

###############################################################################
# Step 2: Build Packages (if needed)
###############################################################################

if [ "$SKIP_BUILD" = false ]; then
  echo -e "${YELLOW}[2/5] Building packages...${NC}"

  cd "$PROJECT_ROOT"

  # Check if packages are already built
  if [ ! -d "packages/api-server/dist" ] || [ ! -d "packages/common/dist" ]; then
    echo "  Building TypeScript packages..."
    npm run build:packages
    echo -e "${GREEN}Build complete${NC}"
  else
    echo -e "${GREEN}Packages already built (use --no-build to force rebuild)${NC}"
  fi
  echo ""
else
  echo -e "${YELLOW}[2/5] Skipping build (--no-build flag)${NC}"
  echo ""
fi

###############################################################################
# Step 3: Check Environment Variables
###############################################################################

echo -e "${YELLOW}[3/5] Checking environment configuration...${NC}"

# Load .env file if it exists
if [ -f "$PROJECT_ROOT/.env" ]; then
  export $(cat "$PROJECT_ROOT/.env" | grep -v '^#' | xargs)
  echo -e "${GREEN}Loaded .env file${NC}"
else
  echo -e "${YELLOW}No .env file found, using defaults${NC}"
fi

# Set default values
export NEO4J_URI="${NEO4J_URI:-bolt://localhost:7687}"
export NEO4J_USERNAME="${NEO4J_USERNAME:-neo4j}"
export NEO4J_PASSWORD="${NEO4J_PASSWORD:-cmdb_password_dev}"
export POSTGRES_HOST="${POSTGRES_HOST:-localhost}"
export POSTGRES_PORT="${POSTGRES_PORT:-5432}"
export POSTGRES_DB="${POSTGRES_DB:-cmdb_datamart}"
export POSTGRES_USER="${POSTGRES_USER:-postgres}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-cmdb_password_dev}"
export REDIS_HOST="${REDIS_HOST:-localhost}"
export REDIS_PORT="${REDIS_PORT:-6379}"
export API_PORT="${API_PORT:-8080}"
export JWT_SECRET="${JWT_SECRET:-dev-secret-key-change-in-production}"

echo "  Neo4j: $NEO4J_URI"
echo "  PostgreSQL: $POSTGRES_HOST:$POSTGRES_PORT/$POSTGRES_DB"
echo "  Redis: $REDIS_HOST:$REDIS_PORT"
echo "  API Port: $API_PORT"
echo ""

###############################################################################
# Step 4: Load Seed Data
###############################################################################

if [ "$SKIP_SEED" = false ]; then
  echo -e "${YELLOW}[4/5] Loading seed data...${NC}"

  cd "$PROJECT_ROOT"

  # Check if ts-node is available
  if ! command -v ts-node &> /dev/null; then
    echo -e "${RED}ts-node not found. Installing...${NC}"
    npm install -g ts-node
  fi

  # Run seed data script
  echo "  Running seed data loader..."
  npx ts-node infrastructure/scripts/seed-data.ts

  echo -e "${GREEN}Seed data loaded successfully${NC}"
  echo ""
else
  echo -e "${YELLOW}[4/5] Skipping seed data (--no-seed flag)${NC}"
  echo ""
fi

###############################################################################
# Step 5: Start API Server
###############################################################################

echo -e "${YELLOW}[5/5] Starting API server...${NC}"

cd "$PROJECT_ROOT"

# Kill any existing API server process
if [ -f ".api.pid" ]; then
  OLD_PID=$(cat .api.pid)
  if ps -p $OLD_PID > /dev/null; then
    echo "  Stopping existing API server (PID: $OLD_PID)..."
    kill $OLD_PID 2>/dev/null || true
    sleep 2
  fi
  rm .api.pid
fi

# Start API server in background
echo "  Starting API server on port $API_PORT..."
npm run dev:api > api-server.log 2>&1 &
API_PID=$!
echo $API_PID > .api.pid

# Wait for server to start
echo "  Waiting for server to be ready..."
MAX_RETRIES=30
RETRY_COUNT=0

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
  if curl -s http://localhost:$API_PORT/api/health > /dev/null 2>&1; then
    echo -e "${GREEN}API server is ready!${NC}"
    break
  fi

  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo -e "${RED}ERROR: API server failed to start after ${MAX_RETRIES} attempts${NC}"
    echo -e "${YELLOW}Check api-server.log for details${NC}"
    exit 1
  fi

  sleep 1
done

echo ""

###############################################################################
# Success Summary
###############################################################################

echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}HappyCMDB Full Stack Started Successfully!${NC}"
echo -e "${GREEN}=========================================${NC}"
echo ""

echo -e "${BLUE}Service URLs:${NC}"
echo "  API Server:       http://localhost:$API_PORT"
echo "  Health Check:     http://localhost:$API_PORT/api/health"
echo "  GraphQL:          http://localhost:$API_PORT/graphql"
echo "  Metrics:          http://localhost:$API_PORT/metrics"
echo ""

echo -e "${BLUE}Test Credentials:${NC}"
echo "  Email:            admin@happycmdb.local"
echo "  Password:         Admin123!"
echo "  Role:             admin"
echo ""

echo -e "${BLUE}Test Authentication:${NC}"
echo "  Login endpoint:   POST http://localhost:$API_PORT/api/v1/auth/login"
echo "  Example curl:"
echo '  curl -X POST http://localhost:'"$API_PORT"'/api/v1/auth/login \'
echo '    -H "Content-Type: application/json" \'
echo '    -d '"'"'{"username": "admin", "password": "Admin123!"}'"'"
echo ""

echo -e "${BLUE}Quick API Tests:${NC}"
echo "  # Get all CIs"
echo "  curl http://localhost:$API_PORT/api/v1/cis"
echo ""
echo "  # Search CIs by type"
echo "  curl http://localhost:$API_PORT/api/v1/cis?type=server"
echo ""
echo "  # Get CI relationships"
echo "  curl http://localhost:$API_PORT/api/v1/cis/srv-prod-web-01/relationships"
echo ""

echo -e "${BLUE}Database Statistics:${NC}"

# Query Neo4j for statistics
NEO4J_STATS=$(docker exec -i neo4j cypher-shell -u "$NEO4J_USERNAME" -p "$NEO4J_PASSWORD" \
  "MATCH (n:CI) RETURN count(n) as ci_count" 2>/dev/null | grep -o '[0-9]\+' | head -1 || echo "0")

echo "  Total CIs:        $NEO4J_STATS"
echo ""

echo -e "${BLUE}Logs:${NC}"
echo "  API Server:       tail -f $PROJECT_ROOT/api-server.log"
echo "  Docker Services:  docker-compose logs -f"
echo ""

echo -e "${YELLOW}To stop the API server:${NC}"
echo "  kill \$(cat $PROJECT_ROOT/.api.pid)"
echo ""
echo -e "${YELLOW}To stop all services:${NC}"
echo "  docker-compose down"
echo ""

echo -e "${GREEN}Happy Testing! 🎉${NC}"
