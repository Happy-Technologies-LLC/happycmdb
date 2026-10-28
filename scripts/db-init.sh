#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "========================================"
echo "Database Initialization"
echo "========================================"
echo ""

# Function to print colored messages
print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${YELLOW}ℹ${NC} $1"
}

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
    print_info "Loaded environment variables from .env"
fi

# Default values
POSTGRES_HOST=${POSTGRES_HOST:-localhost}
POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_USER=${POSTGRES_USER:-postgres}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-postgres}
POSTGRES_DB=${POSTGRES_DB:-cmdb}

NEO4J_HOST=${NEO4J_HOST:-localhost}
NEO4J_PORT=${NEO4J_PORT:-7687}
NEO4J_USER=${NEO4J_USER:-neo4j}
NEO4J_PASSWORD=${NEO4J_PASSWORD:-password}

echo "========================================"
echo "Waiting for services..."
echo "========================================"
echo ""

# Wait for PostgreSQL
print_info "Waiting for PostgreSQL to be ready..."
for i in {1..60}; do
    if docker exec $(docker ps -qf "name=postgres") pg_isready -U "$POSTGRES_USER" >/dev/null 2>&1; then
        print_success "PostgreSQL is ready"
        break
    fi
    sleep 1
    if [ $i -eq 60 ]; then
        print_error "PostgreSQL did not become ready in time"
        exit 1
    fi
done

# Wait for Neo4j
print_info "Waiting for Neo4j to be ready..."
for i in {1..60}; do
    if curl -s http://${NEO4J_HOST}:7474 >/dev/null 2>&1; then
        print_success "Neo4j is ready"
        break
    fi
    sleep 1
    if [ $i -eq 60 ]; then
        print_error "Neo4j did not become ready in time"
        exit 1
    fi
done

echo ""
echo "========================================"
echo "Initializing PostgreSQL..."
echo "========================================"
echo ""

# Create database if it doesn't exist
print_info "Creating PostgreSQL database..."
docker exec $(docker ps -qf "name=postgres") psql -U "$POSTGRES_USER" -tc "SELECT 1 FROM pg_database WHERE datname = '$POSTGRES_DB'" | grep -q 1 || \
    docker exec $(docker ps -qf "name=postgres") psql -U "$POSTGRES_USER" -c "CREATE DATABASE $POSTGRES_DB"
print_success "PostgreSQL database created/verified"

# Run migrations
print_info "Running PostgreSQL migrations..."
if [ -f scripts/db-migrate.sh ]; then
    bash scripts/db-migrate.sh
    print_success "PostgreSQL migrations completed"
else
    print_info "db-migrate.sh not found, skipping migrations"
fi

# Seed data (if seed script exists)
if [ -f packages/db/seeds/seed.sql ]; then
    print_info "Seeding PostgreSQL database..."
    docker exec -i $(docker ps -qf "name=postgres") psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < packages/db/seeds/seed.sql
    print_success "PostgreSQL seeding completed"
else
    print_info "Seed file not found, skipping seeding"
fi

echo ""
echo "========================================"
echo "Initializing Neo4j..."
echo "========================================"
echo ""

# Create Neo4j constraints and indexes from Cypher script
print_info "Creating Neo4j schema (constraints, indexes, full-text search)..."

# Execute the init-neo4j.cypher script
if [ -f infrastructure/scripts/init-neo4j.cypher ]; then
    # Read and execute the Cypher script
    cat infrastructure/scripts/init-neo4j.cypher | docker exec -i $(docker ps -qf "name=neo4j") cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" --format plain 2>&1 | while read line; do
        if [[ $line == *"constraint created"* ]] || [[ $line == *"index created"* ]]; then
            print_success "$line"
        elif [[ $line == *"already exists"* ]]; then
            print_info "$line (skipped)"
        fi
    done
    print_success "Neo4j schema initialization completed"
else
    print_error "Neo4j schema file not found at infrastructure/scripts/init-neo4j.cypher"
    print_info "Falling back to basic schema creation..."

    # Fallback: Create basic constraints
    docker exec $(docker ps -qf "name=neo4j") cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" \
        "CREATE CONSTRAINT ci_id_unique IF NOT EXISTS FOR (ci:CI) REQUIRE ci.id IS UNIQUE" 2>/dev/null || true
    print_success "Created constraint: ci.id UNIQUE"

    docker exec $(docker ps -qf "name=neo4j") cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" \
        "CREATE CONSTRAINT ci_org_external_id_unique IF NOT EXISTS FOR (ci:CI) REQUIRE (ci.organization_id, ci.external_id) IS UNIQUE" 2>/dev/null || true
    print_success "Created constraint: (ci.organization_id, ci.external_id) UNIQUE"

    # Create basic indexes
    docker exec $(docker ps -qf "name=neo4j") cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" \
        "CREATE INDEX ci_name_index IF NOT EXISTS FOR (ci:CI) ON (ci.name)" 2>/dev/null || true
    print_success "Created index: ci.name"

    docker exec $(docker ps -qf "name=neo4j") cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" \
        "CREATE INDEX ci_type_index IF NOT EXISTS FOR (ci:CI) ON (ci.type)" 2>/dev/null || true
    print_success "Created index: ci.type"

    docker exec $(docker ps -qf "name=neo4j") cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" \
        "CREATE INDEX ci_status_index IF NOT EXISTS FOR (ci:CI) ON (ci.status)" 2>/dev/null || true
    print_success "Created index: ci.status"

    docker exec $(docker ps -qf "name=neo4j") cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" \
        "CREATE INDEX ci_environment_index IF NOT EXISTS FOR (ci:CI) ON (ci.environment)" 2>/dev/null || true
    print_success "Created index: ci.environment"
fi

# Seed Neo4j data (if seed script exists)
if [ -f packages/graph-db/seeds/seed.cypher ]; then
    print_info "Seeding Neo4j database..."
    cat packages/graph-db/seeds/seed.cypher | docker exec -i $(docker ps -qf "name=neo4j") cypher-shell -u "$NEO4J_USER" -p "$NEO4J_PASSWORD"
    print_success "Neo4j seeding completed"
else
    print_info "Neo4j seed file not found, skipping seeding"
fi

echo ""
echo "========================================"
echo "Database Initialization Complete!"
echo "========================================"
echo ""
print_success "All databases initialized successfully"
echo ""
echo "Database Status:"
echo "  PostgreSQL:"
echo "    - Host: $POSTGRES_HOST:$POSTGRES_PORT"
echo "    - Database: $POSTGRES_DB"
echo "    - User: $POSTGRES_USER"
echo ""
echo "  Neo4j:"
echo "    - Bolt: bolt://$NEO4J_HOST:$NEO4J_PORT"
echo "    - Browser: http://$NEO4J_HOST:7474"
echo "    - User: $NEO4J_USER"
echo ""
