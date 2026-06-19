#!/bin/bash
# Neo4j Cluster Initialization Script
# Sets up constraints and indexes for the CMDB graph database

set -e

NEO4J_URI="${NEO4J_URI:-neo4j://neo4j-core-1:7687}"
NEO4J_USER="${NEO4J_USER:-neo4j}"
NEO4J_PASSWORD="${NEO4J_PASSWORD:-cmdb_dev_password}"

echo "Waiting for Neo4j cluster to be ready..."
sleep 120

echo "Connecting to Neo4j at $NEO4J_URI"

# Function to execute Cypher query
execute_cypher() {
  local query=$1
  echo "Executing: $query"
  cypher-shell -a "$NEO4J_URI" -u "$NEO4J_USER" -p "$NEO4J_PASSWORD" "$query"
}

echo "Creating constraints..."

# Unique constraints for CI IDs
execute_cypher "CREATE CONSTRAINT ci_id_unique IF NOT EXISTS FOR (c:CI) REQUIRE c.id IS UNIQUE;"
execute_cypher "CREATE CONSTRAINT server_id_unique IF NOT EXISTS FOR (s:Server) REQUIRE s.id IS UNIQUE;"
execute_cypher "CREATE CONSTRAINT application_id_unique IF NOT EXISTS FOR (a:Application) REQUIRE a.id IS UNIQUE;"
execute_cypher "CREATE CONSTRAINT database_id_unique IF NOT EXISTS FOR (d:Database) REQUIRE d.id IS UNIQUE;"
execute_cypher "CREATE CONSTRAINT network_device_id_unique IF NOT EXISTS FOR (n:NetworkDevice) REQUIRE n.id IS UNIQUE;"
execute_cypher "CREATE CONSTRAINT storage_id_unique IF NOT EXISTS FOR (s:Storage) REQUIRE s.id IS UNIQUE;"
execute_cypher "CREATE CONSTRAINT container_id_unique IF NOT EXISTS FOR (c:Container) REQUIRE c.id IS UNIQUE;"
execute_cypher "CREATE CONSTRAINT cloud_resource_id_unique IF NOT EXISTS FOR (c:CloudResource) REQUIRE c.id IS UNIQUE;"

echo "Creating indexes..."

# Performance indexes
execute_cypher "CREATE INDEX ci_name_index IF NOT EXISTS FOR (c:CI) ON (c.name);"
execute_cypher "CREATE INDEX ci_type_index IF NOT EXISTS FOR (c:CI) ON (c.ci_type);"
execute_cypher "CREATE INDEX ci_environment_index IF NOT EXISTS FOR (c:CI) ON (c.environment);"
execute_cypher "CREATE INDEX ci_status_index IF NOT EXISTS FOR (c:CI) ON (c.status);"
execute_cypher "CREATE INDEX ci_discovered_at_index IF NOT EXISTS FOR (c:CI) ON (c.discovered_at);"
execute_cypher "CREATE INDEX ci_last_seen_index IF NOT EXISTS FOR (c:CI) ON (c.last_seen);"

# Cloud provider indexes
execute_cypher "CREATE INDEX ci_cloud_provider_index IF NOT EXISTS FOR (c:CI) ON (c.cloud_provider);"
execute_cypher "CREATE INDEX ci_cloud_account_index IF NOT EXISTS FOR (c:CI) ON (c.cloud_account_id);"
execute_cypher "CREATE INDEX ci_cloud_region_index IF NOT EXISTS FOR (c:CI) ON (c.cloud_region);"

echo "Creating full-text search indexes..."

execute_cypher "CREATE FULLTEXT INDEX ci_fulltext_search IF NOT EXISTS FOR (c:CI) ON EACH [c.name, c.description, c.tags];"

echo "Verifying database setup..."
execute_cypher "SHOW CONSTRAINTS;"
execute_cypher "SHOW INDEXES;"

# Create sample data structure
echo "Creating initial system nodes..."
execute_cypher "
MERGE (sys:System {id: 'happycmdb-cmdb', name: 'HappyCMDB'})
SET sys.version = '1.0.0',
    sys.initialized_at = datetime(),
    sys.last_updated = datetime()
RETURN sys;
"

echo "Neo4j cluster initialization complete!"
