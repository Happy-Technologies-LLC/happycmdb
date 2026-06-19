#!/bin/bash

# ============================================
# HappyCMDB v3.0 - Metabase Setup Automation
# ============================================
# This script automates the initial setup of Metabase:
# - Waits for Metabase to be ready
# - Creates admin user
# - Configures database connection
# - Creates database views
# - Optionally imports dashboards and questions
# ============================================

set -e  # Exit on error
set -u  # Exit on undefined variable

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
METABASE_URL="${METABASE_URL:-http://localhost:3002}"
METABASE_ADMIN_EMAIL="${METABASE_ADMIN_EMAIL:-admin@happycmdb.local}"
METABASE_ADMIN_PASSWORD="${METABASE_ADMIN_PASSWORD:-admin_password_change_me}"
METABASE_ADMIN_FIRST_NAME="${METABASE_ADMIN_FIRST_NAME:-Admin}"
METABASE_ADMIN_LAST_NAME="${METABASE_ADMIN_LAST_NAME:-User}"

# Database connection settings
DB_HOST="${POSTGRES_HOST:-localhost}"
DB_PORT="${POSTGRES_PORT:-5433}"
DB_NAME="${POSTGRES_DATABASE:-cmdb}"
DB_USER="${METABASE_READONLY_USER:-metabase_readonly}"
DB_PASSWORD="${METABASE_READONLY_PASSWORD:-readonly_password_change_me}"

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$(dirname "$SCRIPT_DIR")")"

# ============================================
# Helper Functions
# ============================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# ============================================
# Wait for Metabase to be ready
# ============================================
wait_for_metabase() {
    log_info "Waiting for Metabase to start at ${METABASE_URL}..."

    local max_attempts=60
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if curl -f -s "${METABASE_URL}/api/health" > /dev/null 2>&1; then
            log_success "Metabase is ready!"
            return 0
        fi

        attempt=$((attempt + 1))
        echo -n "."
        sleep 5
    done

    log_error "Metabase failed to start after ${max_attempts} attempts"
    return 1
}

# ============================================
# Get setup token
# ============================================
get_setup_token() {
    log_info "Retrieving setup token..."

    local response=$(curl -s "${METABASE_URL}/api/session/properties")
    local token=$(echo "$response" | grep -o '"setup-token":"[^"]*"' | cut -d'"' -f4)

    if [ -z "$token" ]; then
        log_warning "No setup token found. Metabase may already be configured."
        return 1
    fi

    echo "$token"
}

# ============================================
# Setup Metabase with admin user and database
# ============================================
setup_metabase() {
    log_info "Setting up Metabase with admin user and database connection..."

    local setup_token="$1"

    local setup_payload=$(cat <<EOF
{
    "token": "${setup_token}",
    "user": {
        "first_name": "${METABASE_ADMIN_FIRST_NAME}",
        "last_name": "${METABASE_ADMIN_LAST_NAME}",
        "email": "${METABASE_ADMIN_EMAIL}",
        "password": "${METABASE_ADMIN_PASSWORD}",
        "site_name": "HappyCMDB v3.0 Analytics"
    },
    "database": {
        "engine": "postgres",
        "name": "HappyCMDB",
        "details": {
            "host": "${DB_HOST}",
            "port": ${DB_PORT},
            "dbname": "${DB_NAME}",
            "user": "${DB_USER}",
            "password": "${DB_PASSWORD}",
            "ssl": false,
            "tunnel-enabled": false,
            "advanced-options": false
        }
    },
    "prefs": {
        "site_name": "HappyCMDB v3.0 Analytics",
        "allow_tracking": false
    }
}
EOF
)

    local response=$(curl -s -X POST \
        "${METABASE_URL}/api/setup" \
        -H "Content-Type: application/json" \
        -d "$setup_payload")

    if echo "$response" | grep -q '"id"'; then
        log_success "Metabase setup completed successfully!"
        echo "$response"
        return 0
    else
        log_error "Metabase setup failed: $response"
        return 1
    fi
}

# ============================================
# Login to Metabase and get session token
# ============================================
login_metabase() {
    log_info "Logging in to Metabase..."

    local login_payload=$(cat <<EOF
{
    "username": "${METABASE_ADMIN_EMAIL}",
    "password": "${METABASE_ADMIN_PASSWORD}"
}
EOF
)

    local response=$(curl -s -X POST \
        "${METABASE_URL}/api/session" \
        -H "Content-Type: application/json" \
        -d "$login_payload")

    local session_id=$(echo "$response" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

    if [ -z "$session_id" ]; then
        log_error "Login failed: $response"
        return 1
    fi

    log_success "Successfully logged in to Metabase"
    echo "$session_id"
}

# ============================================
# Create database views
# ============================================
create_database_views() {
    log_info "Creating database views for BI analysis..."

    # Check if psql is available
    if ! command -v psql &> /dev/null; then
        log_warning "psql not found. Skipping view creation."
        log_warning "Please run the SQL scripts manually:"
        log_warning "  - infrastructure/database/views/cost-analysis.sql"
        log_warning "  - infrastructure/database/views/itil-analysis.sql"
        log_warning "  - infrastructure/database/views/bsm-analysis.sql"
        return 0
    fi

    # Create views
    local view_files=(
        "${PROJECT_ROOT}/infrastructure/database/views/cost-analysis.sql"
        "${PROJECT_ROOT}/infrastructure/database/views/itil-analysis.sql"
        "${PROJECT_ROOT}/infrastructure/database/views/bsm-analysis.sql"
    )

    for view_file in "${view_files[@]}"; do
        if [ -f "$view_file" ]; then
            log_info "Creating views from $(basename "$view_file")..."

            PGPASSWORD="${POSTGRES_PASSWORD}" psql \
                -h "${DB_HOST}" \
                -p "${DB_PORT}" \
                -U "${POSTGRES_USER:-cmdb_user}" \
                -d "${DB_NAME}" \
                -f "$view_file" \
                > /dev/null 2>&1

            if [ $? -eq 0 ]; then
                log_success "Views created from $(basename "$view_file")"
            else
                log_warning "Failed to create views from $(basename "$view_file")"
            fi
        else
            log_warning "View file not found: $view_file"
        fi
    done
}

# ============================================
# Sync database schema
# ============================================
sync_database_schema() {
    log_info "Triggering database schema sync..."

    local session_id="$1"

    # Get database ID
    local databases=$(curl -s -X GET \
        "${METABASE_URL}/api/database" \
        -H "X-Metabase-Session: ${session_id}")

    local db_id=$(echo "$databases" | grep -o '"id":[0-9]*' | head -1 | cut -d':' -f2)

    if [ -z "$db_id" ]; then
        log_warning "Could not find database ID. Schema sync skipped."
        return 1
    fi

    # Trigger schema sync
    local response=$(curl -s -X POST \
        "${METABASE_URL}/api/database/${db_id}/sync_schema" \
        -H "X-Metabase-Session: ${session_id}")

    log_success "Database schema sync triggered (DB ID: ${db_id})"

    # Wait for sync to complete
    log_info "Waiting for schema sync to complete (this may take a minute)..."
    sleep 30
}

# ============================================
# Create collections
# ============================================
create_collections() {
    log_info "Creating Metabase collections..."

    local session_id="$1"

    local collections=(
        "Executive Reports"
        "Cost Analysis"
        "FinOps"
        "ITIL Service Management"
        "Compliance"
        "Business Impact"
        "Service Health"
    )

    for collection_name in "${collections[@]}"; do
        local payload=$(cat <<EOF
{
    "name": "${collection_name}",
    "color": "#509EE3",
    "description": "HappyCMDB v3.0 ${collection_name}"
}
EOF
)

        curl -s -X POST \
            "${METABASE_URL}/api/collection" \
            -H "Content-Type: application/json" \
            -H "X-Metabase-Session: ${session_id}" \
            -d "$payload" > /dev/null

        log_success "Created collection: ${collection_name}"
    done
}

# ============================================
# Display summary
# ============================================
display_summary() {
    echo ""
    echo "============================================"
    log_success "Metabase Setup Complete!"
    echo "============================================"
    echo ""
    echo "Access Metabase at: ${METABASE_URL}"
    echo ""
    echo "Login Credentials:"
    echo "  Email:    ${METABASE_ADMIN_EMAIL}"
    echo "  Password: ${METABASE_ADMIN_PASSWORD}"
    echo ""
    log_warning "IMPORTANT: Change the admin password after first login!"
    echo ""
    echo "Next Steps:"
    echo "  1. Log in to Metabase"
    echo "  2. Explore the pre-configured views and collections"
    echo "  3. Import dashboards from infrastructure/metabase/dashboards/"
    echo "  4. Create custom questions from infrastructure/metabase/questions/"
    echo "  5. Set up scheduled email reports"
    echo ""
    echo "Documentation:"
    echo "  See infrastructure/metabase/README.md for detailed usage"
    echo ""
    echo "============================================"
}

# ============================================
# Main Execution
# ============================================
main() {
    log_info "Starting Metabase setup automation..."
    echo ""

    # Step 1: Wait for Metabase
    if ! wait_for_metabase; then
        log_error "Metabase is not accessible. Please check if the container is running."
        exit 1
    fi
    echo ""

    # Step 2: Get setup token and perform initial setup
    setup_token=$(get_setup_token)

    if [ -n "$setup_token" ]; then
        log_info "Performing initial Metabase setup..."
        if setup_metabase "$setup_token"; then
            log_success "Initial setup completed"
            sleep 5  # Wait for setup to complete
        else
            log_error "Initial setup failed"
            exit 1
        fi
    else
        log_info "Metabase already configured. Logging in..."
    fi
    echo ""

    # Step 3: Login and get session
    session_id=$(login_metabase)
    if [ -z "$session_id" ]; then
        log_error "Failed to authenticate with Metabase"
        exit 1
    fi
    echo ""

    # Step 4: Create database views
    create_database_views
    echo ""

    # Step 5: Sync database schema
    sync_database_schema "$session_id"
    echo ""

    # Step 6: Create collections
    create_collections "$session_id"
    echo ""

    # Step 7: Display summary
    display_summary
}

# Run main function
main "$@"
