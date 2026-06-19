// Neo4j Database Schema Initialization for CMDB Platform
// This script creates constraints, indexes, full-text search capabilities, and comprehensive test data
// for the Configuration Management Database

// ============================================
// CONSTRAINTS - Ensure data integrity
// ============================================

// Unique constraint on CI.id - Primary identifier
CREATE CONSTRAINT ci_id_unique IF NOT EXISTS
FOR (ci:CI) REQUIRE ci.id IS UNIQUE;

// Unique constraint on CI.external_id - External system identifier
CREATE CONSTRAINT ci_external_id_unique IF NOT EXISTS
FOR (ci:CI) REQUIRE ci.external_id IS UNIQUE;

// Unique constraint on User.email - User email identifier
CREATE CONSTRAINT user_email_unique IF NOT EXISTS
FOR (u:User) REQUIRE u.email IS UNIQUE;

// Unique constraint on User.id - User identifier
CREATE CONSTRAINT user_id_unique IF NOT EXISTS
FOR (u:User) REQUIRE u.id IS UNIQUE;

// ============================================
// NODE LABEL CONSTRAINTS
// ============================================
// These ensure that specific CI types have the CI label as well

// Server nodes
CREATE CONSTRAINT server_id_unique IF NOT EXISTS
FOR (s:Server) REQUIRE s.id IS UNIQUE;

// VirtualMachine nodes
CREATE CONSTRAINT vm_id_unique IF NOT EXISTS
FOR (vm:VirtualMachine) REQUIRE vm.id IS UNIQUE;

// Container nodes
CREATE CONSTRAINT container_id_unique IF NOT EXISTS
FOR (c:Container) REQUIRE c.id IS UNIQUE;

// Application nodes
CREATE CONSTRAINT application_id_unique IF NOT EXISTS
FOR (app:Application) REQUIRE app.id IS UNIQUE;

// Service nodes
CREATE CONSTRAINT service_id_unique IF NOT EXISTS
FOR (svc:Service) REQUIRE svc.id IS UNIQUE;

// Database nodes
CREATE CONSTRAINT database_id_unique IF NOT EXISTS
FOR (db:Database) REQUIRE db.id IS UNIQUE;

// NetworkDevice nodes
CREATE CONSTRAINT network_device_id_unique IF NOT EXISTS
FOR (nd:NetworkDevice) REQUIRE nd.id IS UNIQUE;

// Storage nodes
CREATE CONSTRAINT storage_id_unique IF NOT EXISTS
FOR (st:Storage) REQUIRE st.id IS UNIQUE;

// LoadBalancer nodes
CREATE CONSTRAINT load_balancer_id_unique IF NOT EXISTS
FOR (lb:LoadBalancer) REQUIRE lb.id IS UNIQUE;

// CloudResource nodes
CREATE CONSTRAINT cloud_resource_id_unique IF NOT EXISTS
FOR (cr:CloudResource) REQUIRE cr.id IS UNIQUE;

// ============================================
// INDEXES - Optimize query performance
// ============================================

// Index on CI.name - Frequently used for lookups
CREATE INDEX ci_name_index IF NOT EXISTS
FOR (ci:CI) ON (ci.name);

// Index on CI.type - Used for filtering by CI type
CREATE INDEX ci_type_index IF NOT EXISTS
FOR (ci:CI) ON (ci.type);

// Index on CI.status - Used for filtering by operational status
CREATE INDEX ci_status_index IF NOT EXISTS
FOR (ci:CI) ON (ci.status);

// Index on CI.environment - Used for filtering by deployment environment
CREATE INDEX ci_environment_index IF NOT EXISTS
FOR (ci:CI) ON (ci.environment);

// Index on CI.created_at - Useful for temporal queries
CREATE INDEX ci_created_at_index IF NOT EXISTS
FOR (ci:CI) ON (ci.created_at);

// Index on CI.updated_at - Useful for finding recently modified CIs
CREATE INDEX ci_updated_at_index IF NOT EXISTS
FOR (ci:CI) ON (ci.updated_at);

// Index on CI.discovered_at - Useful for discovery-related queries
CREATE INDEX ci_discovered_at_index IF NOT EXISTS
FOR (ci:CI) ON (ci.discovered_at);

// Index on User.username - Frequently used for authentication
CREATE INDEX user_username_index IF NOT EXISTS
FOR (u:User) ON (u.username);

// ============================================
// COMPOSITE INDEXES - Multi-property queries
// ============================================

// Composite index for environment + status queries
CREATE INDEX ci_env_status_index IF NOT EXISTS
FOR (ci:CI) ON (ci.environment, ci.status);

// Composite index for type + status queries
CREATE INDEX ci_type_status_index IF NOT EXISTS
FOR (ci:CI) ON (ci.type, ci.status);

// ============================================
// FULL-TEXT SEARCH INDEX
// ============================================

// Full-text search on CI names and metadata
// Supports fuzzy matching and relevance scoring
CREATE FULLTEXT INDEX ci_fulltext_search IF NOT EXISTS
FOR (ci:CI)
ON EACH [ci.name, ci.metadata];

// ============================================
// INITIAL USER DATA
// ============================================

// Create admin user
// Password: Admin123! (bcrypt hash)
MERGE (u:User {email: 'admin@happycmdb.local'})
SET u.id = 'user-admin-001',
    u.username = 'admin',
    u.passwordHash = '$2b$10$rKZLwXqF6kE7H4N5gHx.pOzF9bXZC.qvJKE7Bz7YLqGxHWqP6H8Jy',
    u.role = 'admin',
    u.enabled = true,
    u.createdAt = datetime(),
    u.updatedAt = datetime();

// ============================================
// SAMPLE CI DATA - SERVERS
// ============================================

// Production Linux Servers
MERGE (s1:CI:Server {id: 'srv-prod-web-01'})
SET s1.name = 'web-prod-01.happycmdb.local',
    s1.type = 'server',
    s1.status = 'active',
    s1.environment = 'production',
    s1.external_id = 'i-0a1b2c3d4e5f6g7h8',
    s1.created_at = datetime(),
    s1.updated_at = datetime(),
    s1.discovered_at = datetime(),
    s1.metadata = '{
      "os": "Ubuntu 22.04 LTS",
      "os_family": "Linux",
      "kernel": "5.15.0-76-generic",
      "hostname": "web-prod-01",
      "ip_address": "10.0.1.10",
      "public_ip": "54.210.123.45",
      "cpu_cores": 8,
      "memory_gb": 32,
      "disk_gb": 500,
      "cloud_provider": "AWS",
      "instance_type": "t3.2xlarge",
      "availability_zone": "us-east-1a",
      "tags": ["production", "web-server", "frontend"]
    }';

MERGE (s2:CI:Server {id: 'srv-prod-web-02'})
SET s2.name = 'web-prod-02.happycmdb.local',
    s2.type = 'server',
    s2.status = 'active',
    s2.environment = 'production',
    s2.external_id = 'i-9h8g7f6e5d4c3b2a1',
    s2.created_at = datetime(),
    s2.updated_at = datetime(),
    s2.discovered_at = datetime(),
    s2.metadata = '{
      "os": "Ubuntu 22.04 LTS",
      "os_family": "Linux",
      "kernel": "5.15.0-76-generic",
      "hostname": "web-prod-02",
      "ip_address": "10.0.1.11",
      "public_ip": "54.210.123.46",
      "cpu_cores": 8,
      "memory_gb": 32,
      "disk_gb": 500,
      "cloud_provider": "AWS",
      "instance_type": "t3.2xlarge",
      "availability_zone": "us-east-1b",
      "tags": ["production", "web-server", "frontend"]
    }';

MERGE (s3:CI:Server {id: 'srv-prod-api-01'})
SET s3.name = 'api-prod-01.happycmdb.local',
    s3.type = 'server',
    s3.status = 'active',
    s3.environment = 'production',
    s3.external_id = 'i-1a2b3c4d5e6f7g8h9',
    s3.created_at = datetime(),
    s3.updated_at = datetime(),
    s3.discovered_at = datetime(),
    s3.metadata = '{
      "os": "Ubuntu 22.04 LTS",
      "os_family": "Linux",
      "kernel": "5.15.0-76-generic",
      "hostname": "api-prod-01",
      "ip_address": "10.0.2.10",
      "public_ip": "54.210.124.10",
      "cpu_cores": 16,
      "memory_gb": 64,
      "disk_gb": 1000,
      "cloud_provider": "AWS",
      "instance_type": "c5.4xlarge",
      "availability_zone": "us-east-1a",
      "tags": ["production", "api-server", "backend"]
    }';

MERGE (s4:CI:Server {id: 'srv-prod-db-01'})
SET s4.name = 'db-prod-01.happycmdb.local',
    s4.type = 'server',
    s4.status = 'active',
    s4.environment = 'production',
    s4.external_id = 'i-2b3c4d5e6f7g8h9i0',
    s4.created_at = datetime(),
    s4.updated_at = datetime(),
    s4.discovered_at = datetime(),
    s4.metadata = '{
      "os": "Ubuntu 22.04 LTS",
      "os_family": "Linux",
      "kernel": "5.15.0-76-generic",
      "hostname": "db-prod-01",
      "ip_address": "10.0.3.10",
      "cpu_cores": 32,
      "memory_gb": 128,
      "disk_gb": 4000,
      "cloud_provider": "AWS",
      "instance_type": "r5.8xlarge",
      "availability_zone": "us-east-1a",
      "tags": ["production", "database-server", "postgres"]
    }';

// Windows Servers
MERGE (s5:CI:Server {id: 'srv-prod-win-01'})
SET s5.name = 'win-prod-01.happycmdb.local',
    s5.type = 'server',
    s5.status = 'active',
    s5.environment = 'production',
    s5.external_id = 'i-3c4d5e6f7g8h9i0j1',
    s5.created_at = datetime(),
    s5.updated_at = datetime(),
    s5.discovered_at = datetime(),
    s5.metadata = '{
      "os": "Windows Server 2022",
      "os_family": "Windows",
      "hostname": "win-prod-01",
      "ip_address": "10.0.4.10",
      "cpu_cores": 8,
      "memory_gb": 32,
      "disk_gb": 500,
      "cloud_provider": "Azure",
      "instance_type": "Standard_D8s_v3",
      "region": "eastus",
      "tags": ["production", "windows", "ad-controller"]
    }';

// Staging Servers
MERGE (s6:CI:Server {id: 'srv-stg-web-01'})
SET s6.name = 'web-stg-01.happycmdb.local',
    s6.type = 'server',
    s6.status = 'active',
    s6.environment = 'staging',
    s6.external_id = 'i-4d5e6f7g8h9i0j1k2',
    s6.created_at = datetime(),
    s6.updated_at = datetime(),
    s6.discovered_at = datetime(),
    s6.metadata = '{
      "os": "Ubuntu 22.04 LTS",
      "os_family": "Linux",
      "hostname": "web-stg-01",
      "ip_address": "10.1.1.10",
      "cpu_cores": 4,
      "memory_gb": 16,
      "disk_gb": 200,
      "cloud_provider": "AWS",
      "instance_type": "t3.xlarge",
      "availability_zone": "us-east-1a",
      "tags": ["staging", "web-server"]
    }';

MERGE (s7:CI:Server {id: 'srv-stg-api-01'})
SET s7.name = 'api-stg-01.happycmdb.local',
    s7.type = 'server',
    s7.status = 'active',
    s7.environment = 'staging',
    s7.external_id = 'i-5e6f7g8h9i0j1k2l3',
    s7.created_at = datetime(),
    s7.updated_at = datetime(),
    s7.discovered_at = datetime(),
    s7.metadata = '{
      "os": "Ubuntu 22.04 LTS",
      "os_family": "Linux",
      "hostname": "api-stg-01",
      "ip_address": "10.1.2.10",
      "cpu_cores": 4,
      "memory_gb": 16,
      "disk_gb": 200,
      "cloud_provider": "AWS",
      "instance_type": "t3.xlarge",
      "availability_zone": "us-east-1a",
      "tags": ["staging", "api-server"]
    }';

// Development Servers
MERGE (s8:CI:Server {id: 'srv-dev-web-01'})
SET s8.name = 'web-dev-01.happycmdb.local',
    s8.type = 'server',
    s8.status = 'active',
    s8.environment = 'development',
    s8.external_id = 'i-6f7g8h9i0j1k2l3m4',
    s8.created_at = datetime(),
    s8.updated_at = datetime(),
    s8.discovered_at = datetime(),
    s8.metadata = '{
      "os": "Ubuntu 22.04 LTS",
      "os_family": "Linux",
      "hostname": "web-dev-01",
      "ip_address": "10.2.1.10",
      "cpu_cores": 2,
      "memory_gb": 8,
      "disk_gb": 100,
      "cloud_provider": "AWS",
      "instance_type": "t3.medium",
      "availability_zone": "us-east-1a",
      "tags": ["development", "web-server"]
    }';

MERGE (s9:CI:Server {id: 'srv-maint-01'})
SET s9.name = 'backup-maint-01.happycmdb.local',
    s9.type = 'server',
    s9.status = 'maintenance',
    s9.environment = 'production',
    s9.external_id = 'i-7g8h9i0j1k2l3m4n5',
    s9.created_at = datetime(),
    s9.updated_at = datetime(),
    s9.discovered_at = datetime(),
    s9.metadata = '{
      "os": "Ubuntu 20.04 LTS",
      "os_family": "Linux",
      "hostname": "backup-maint-01",
      "ip_address": "10.0.5.10",
      "cpu_cores": 4,
      "memory_gb": 16,
      "disk_gb": 8000,
      "cloud_provider": "AWS",
      "instance_type": "m5.xlarge",
      "availability_zone": "us-east-1c",
      "tags": ["production", "backup-server", "maintenance"]
    }';

MERGE (s10:CI:Server {id: 'srv-decom-01'})
SET s10.name = 'old-web-decom-01.happycmdb.local',
    s10.type = 'server',
    s10.status = 'decommissioned',
    s10.environment = 'production',
    s10.external_id = 'i-8h9i0j1k2l3m4n5o6',
    s10.created_at = datetime(),
    s10.updated_at = datetime(),
    s10.discovered_at = datetime(),
    s10.metadata = '{
      "os": "Ubuntu 18.04 LTS",
      "os_family": "Linux",
      "hostname": "old-web-decom-01",
      "ip_address": "10.0.1.99",
      "cpu_cores": 4,
      "memory_gb": 8,
      "disk_gb": 100,
      "cloud_provider": "AWS",
      "instance_type": "t2.large",
      "availability_zone": "us-east-1a",
      "tags": ["decommissioned", "legacy"]
    }';

// ============================================
// SAMPLE CI DATA - APPLICATIONS
// ============================================

MERGE (a1:CI:Application {id: 'app-web-frontend'})
SET a1.name = 'HappyCMDB Web Frontend',
    a1.type = 'application',
    a1.status = 'active',
    a1.environment = 'production',
    a1.external_id = 'app-frontend-prod',
    a1.created_at = datetime(),
    a1.updated_at = datetime(),
    a1.discovered_at = datetime(),
    a1.metadata = '{
      "version": "2.4.1",
      "framework": "React 18",
      "language": "TypeScript",
      "port": 3000,
      "health_endpoint": "/health",
      "repository": "github.com/happycmdb/web-ui",
      "deployment_method": "docker",
      "tags": ["frontend", "react", "typescript"]
    }';

MERGE (a2:CI:Application {id: 'app-api-backend'})
SET a2.name = 'HappyCMDB API Server',
    a2.type = 'application',
    a2.status = 'active',
    a2.environment = 'production',
    a2.external_id = 'app-api-prod',
    a2.created_at = datetime(),
    a2.updated_at = datetime(),
    a2.discovered_at = datetime(),
    a2.metadata = '{
      "version": "1.8.3",
      "framework": "Express.js",
      "language": "TypeScript",
      "port": 8080,
      "health_endpoint": "/api/health",
      "repository": "github.com/happycmdb/api-server",
      "deployment_method": "docker",
      "tags": ["backend", "api", "express", "nodejs"]
    }';

MERGE (a3:CI:Application {id: 'app-discovery-engine'})
SET a3.name = 'Discovery Engine',
    a3.type = 'application',
    a3.status = 'active',
    a3.environment = 'production',
    a3.external_id = 'app-discovery-prod',
    a3.created_at = datetime(),
    a3.updated_at = datetime(),
    a3.discovered_at = datetime(),
    a3.metadata = '{
      "version": "1.5.0",
      "framework": "BullMQ Worker",
      "language": "TypeScript",
      "repository": "github.com/happycmdb/discovery-engine",
      "deployment_method": "docker",
      "tags": ["worker", "discovery", "aws", "azure"]
    }';

MERGE (a4:CI:Application {id: 'app-etl-processor'})
SET a4.name = 'ETL Processor',
    a4.type = 'application',
    a4.status = 'active',
    a4.environment = 'production',
    a4.external_id = 'app-etl-prod',
    a4.created_at = datetime(),
    a4.updated_at = datetime(),
    a4.discovered_at = datetime(),
    a4.metadata = '{
      "version": "1.3.2",
      "framework": "BullMQ Worker",
      "language": "TypeScript",
      "repository": "github.com/happycmdb/etl-processor",
      "deployment_method": "docker",
      "tags": ["worker", "etl", "data-sync"]
    }';

MERGE (a5:CI:Application {id: 'app-monitoring-agent'})
SET a5.name = 'Monitoring Agent',
    a5.type = 'application',
    a5.status = 'active',
    a5.environment = 'production',
    a5.external_id = 'app-agent-prod',
    a5.created_at = datetime(),
    a5.updated_at = datetime(),
    a5.discovered_at = datetime(),
    a5.metadata = '{
      "version": "1.0.5",
      "language": "Go",
      "repository": "github.com/happycmdb/agent",
      "deployment_method": "binary",
      "tags": ["agent", "monitoring", "metrics"]
    }';

// ============================================
// SAMPLE CI DATA - DATABASES
// ============================================

MERGE (db1:CI:Database {id: 'db-neo4j-prod'})
SET db1.name = 'Neo4j CMDB Production',
    db1.type = 'database',
    db1.status = 'active',
    db1.environment = 'production',
    db1.external_id = 'neo4j-cmdb-prod',
    db1.created_at = datetime(),
    db1.updated_at = datetime(),
    db1.discovered_at = datetime(),
    db1.metadata = '{
      "engine": "Neo4j",
      "version": "5.15.0",
      "edition": "Community",
      "port": 7687,
      "protocol": "bolt",
      "database_size_gb": 245,
      "node_count": 125000,
      "relationship_count": 450000,
      "tags": ["graph-database", "cmdb", "production"]
    }';

MERGE (db2:CI:Database {id: 'db-postgres-datamart'})
SET db2.name = 'PostgreSQL Data Mart',
    db2.type = 'database',
    db2.status = 'active',
    db2.environment = 'production',
    db2.external_id = 'postgres-datamart-prod',
    db2.created_at = datetime(),
    db2.updated_at = datetime(),
    db2.discovered_at = datetime(),
    db2.metadata = '{
      "engine": "PostgreSQL",
      "version": "15.4",
      "extensions": ["timescaledb", "pg_stat_statements"],
      "port": 5432,
      "database_size_gb": 180,
      "connection_pool_size": 100,
      "tags": ["relational-database", "analytics", "production"]
    }';

MERGE (db3:CI:Database {id: 'db-redis-cache'})
SET db3.name = 'Redis Cache Cluster',
    db3.type = 'database',
    db3.status = 'active',
    db3.environment = 'production',
    db3.external_id = 'redis-cache-prod',
    db3.created_at = datetime(),
    db3.updated_at = datetime(),
    db3.discovered_at = datetime(),
    db3.metadata = '{
      "engine": "Redis",
      "version": "7.2.0",
      "cluster_mode": true,
      "port": 6379,
      "memory_gb": 32,
      "eviction_policy": "allkeys-lru",
      "tags": ["cache", "key-value", "production"]
    }';

MERGE (db4:CI:Database {id: 'db-mongo-logs'})
SET db4.name = 'MongoDB Logs Database',
    db4.type = 'database',
    db4.status = 'active',
    db4.environment = 'production',
    db4.external_id = 'mongo-logs-prod',
    db4.created_at = datetime(),
    db4.updated_at = datetime(),
    db4.discovered_at = datetime(),
    db4.metadata = '{
      "engine": "MongoDB",
      "version": "7.0.2",
      "replica_set": true,
      "port": 27017,
      "database_size_gb": 320,
      "collections": 15,
      "tags": ["document-database", "logs", "production"]
    }';

MERGE (db5:CI:Database {id: 'db-mysql-legacy'})
SET db5.name = 'MySQL Legacy Database',
    db5.type = 'database',
    db5.status = 'inactive',
    db5.environment = 'production',
    db5.external_id = 'mysql-legacy-prod',
    db5.created_at = datetime(),
    db5.updated_at = datetime(),
    db5.discovered_at = datetime(),
    db5.metadata = '{
      "engine": "MySQL",
      "version": "5.7.44",
      "port": 3306,
      "database_size_gb": 45,
      "note": "Pending migration to PostgreSQL",
      "tags": ["relational-database", "legacy", "inactive"]
    }';

// ============================================
// SAMPLE CI DATA - SERVICES
// ============================================

MERGE (svc1:CI:Service {id: 'svc-api-gateway'})
SET svc1.name = 'API Gateway Service',
    svc1.type = 'service',
    svc1.status = 'active',
    svc1.environment = 'production',
    svc1.external_id = 'svc-gateway-prod',
    svc1.created_at = datetime(),
    svc1.updated_at = datetime(),
    svc1.discovered_at = datetime(),
    svc1.metadata = '{
      "service_type": "API Gateway",
      "provider": "Kong",
      "version": "3.4.0",
      "port": 8000,
      "admin_port": 8001,
      "rate_limit": 10000,
      "tags": ["gateway", "routing", "production"]
    }';

MERGE (svc2:CI:Service {id: 'svc-auth-service'})
SET svc2.name = 'Authentication Service',
    svc2.type = 'service',
    svc2.status = 'active',
    svc2.environment = 'production',
    svc2.external_id = 'svc-auth-prod',
    svc2.created_at = datetime(),
    svc2.updated_at = datetime(),
    svc2.discovered_at = datetime(),
    svc2.metadata = '{
      "service_type": "Authentication",
      "protocol": "OAuth2",
      "port": 8443,
      "jwt_enabled": true,
      "tags": ["security", "authentication", "production"]
    }';

MERGE (svc3:CI:Service {id: 'svc-metrics-collector'})
SET svc3.name = 'Metrics Collector Service',
    svc3.type = 'service',
    svc3.status = 'active',
    svc3.environment = 'production',
    svc3.external_id = 'svc-metrics-prod',
    svc3.created_at = datetime(),
    svc3.updated_at = datetime(),
    svc3.discovered_at = datetime(),
    svc3.metadata = '{
      "service_type": "Monitoring",
      "provider": "Prometheus",
      "version": "2.47.0",
      "port": 9090,
      "scrape_interval": "15s",
      "tags": ["monitoring", "metrics", "production"]
    }';

MERGE (svc4:CI:Service {id: 'svc-log-aggregator'})
SET svc4.name = 'Log Aggregation Service',
    svc4.type = 'service',
    svc4.status = 'active',
    svc4.environment = 'production',
    svc4.external_id = 'svc-logs-prod',
    svc4.created_at = datetime(),
    svc4.updated_at = datetime(),
    svc4.discovered_at = datetime(),
    svc4.metadata = '{
      "service_type": "Logging",
      "provider": "Loki",
      "version": "2.9.0",
      "port": 3100,
      "retention_days": 90,
      "tags": ["logging", "observability", "production"]
    }';

MERGE (svc5:CI:Service {id: 'svc-queue-manager'})
SET svc5.name = 'Queue Management Service',
    svc5.type = 'service',
    svc5.status = 'active',
    svc5.environment = 'production',
    svc5.external_id = 'svc-queue-prod',
    svc5.created_at = datetime(),
    svc5.updated_at = datetime(),
    svc5.discovered_at = datetime(),
    svc5.metadata = '{
      "service_type": "Message Queue",
      "provider": "BullMQ",
      "version": "4.12.0",
      "queue_count": 8,
      "worker_count": 24,
      "tags": ["queue", "async", "production"]
    }';

// ============================================
// SAMPLE CI DATA - NETWORK DEVICES
// ============================================

MERGE (net1:CI:NetworkDevice {id: 'net-lb-prod-01'})
SET net1.name = 'Production Load Balancer',
    net1.type = 'load-balancer',
    net1.status = 'active',
    net1.environment = 'production',
    net1.external_id = 'elb-prod-web-01',
    net1.created_at = datetime(),
    net1.updated_at = datetime(),
    net1.discovered_at = datetime(),
    net1.metadata = '{
      "device_type": "Application Load Balancer",
      "provider": "AWS ELB",
      "public_dns": "lb-prod-01.happycmdb.com",
      "ip_address": "54.210.200.100",
      "algorithm": "round-robin",
      "health_check_interval": 30,
      "backend_count": 2,
      "tags": ["load-balancer", "production", "aws"]
    }';

MERGE (net2:CI:NetworkDevice {id: 'net-switch-core-01'})
SET net2.name = 'Core Network Switch',
    net2.type = 'network-device',
    net2.status = 'active',
    net2.environment = 'production',
    net2.external_id = 'switch-core-01',
    net2.created_at = datetime(),
    net2.updated_at = datetime(),
    net2.discovered_at = datetime(),
    net2.metadata = '{
      "device_type": "Switch",
      "vendor": "Cisco",
      "model": "Catalyst 9300",
      "ip_address": "10.0.0.1",
      "port_count": 48,
      "vlan_count": 12,
      "firmware": "17.6.4",
      "tags": ["network", "core-switch", "production"]
    }';

MERGE (net3:CI:NetworkDevice {id: 'net-firewall-01'})
SET net3.name = 'Production Firewall',
    net3.type = 'network-device',
    net3.status = 'active',
    net3.environment = 'production',
    net3.external_id = 'fw-prod-01',
    net3.created_at = datetime(),
    net3.updated_at = datetime(),
    net3.discovered_at = datetime(),
    net3.metadata = '{
      "device_type": "Firewall",
      "vendor": "Palo Alto",
      "model": "PA-3220",
      "ip_address": "10.0.0.2",
      "firmware": "10.2.3",
      "rule_count": 234,
      "vpn_enabled": true,
      "tags": ["security", "firewall", "production"]
    }';

MERGE (net4:CI:NetworkDevice {id: 'net-router-edge-01'})
SET net4.name = 'Edge Router',
    net4.type = 'network-device',
    net4.status = 'active',
    net4.environment = 'production',
    net4.external_id = 'router-edge-01',
    net4.created_at = datetime(),
    net4.updated_at = datetime(),
    net4.discovered_at = datetime(),
    net4.metadata = '{
      "device_type": "Router",
      "vendor": "Juniper",
      "model": "MX204",
      "ip_address": "10.0.0.3",
      "bgp_peers": 4,
      "bandwidth_gbps": 100,
      "firmware": "20.4R3",
      "tags": ["network", "router", "edge", "production"]
    }';

MERGE (net5:CI:NetworkDevice {id: 'net-vpn-gateway-01'})
SET net5.name = 'VPN Gateway',
    net5.type = 'network-device',
    net5.status = 'active',
    net5.environment = 'production',
    net5.external_id = 'vpn-gw-01',
    net5.created_at = datetime(),
    net5.updated_at = datetime(),
    net5.discovered_at = datetime(),
    net5.metadata = '{
      "device_type": "VPN Gateway",
      "provider": "AWS VPN",
      "protocol": "IPsec",
      "public_ip": "54.210.210.210",
      "tunnel_count": 2,
      "connection_type": "site-to-site",
      "tags": ["vpn", "security", "production"]
    }';

// ============================================
// SAMPLE CI DATA - STORAGE
// ============================================

MERGE (st1:CI:Storage {id: 'sto-s3-backups'})
SET st1.name = 'S3 Backup Bucket',
    st1.type = 'storage',
    st1.status = 'active',
    st1.environment = 'production',
    st1.external_id = 's3://happycmdb-backups-prod',
    st1.created_at = datetime(),
    st1.updated_at = datetime(),
    st1.discovered_at = datetime(),
    st1.metadata = '{
      "storage_type": "Object Storage",
      "provider": "AWS S3",
      "bucket_name": "happycmdb-backups-prod",
      "size_gb": 2500,
      "versioning": true,
      "encryption": "AES-256",
      "lifecycle_policy": "transition to Glacier after 90 days",
      "tags": ["storage", "backup", "s3", "production"]
    }';

MERGE (st2:CI:Storage {id: 'sto-ebs-db'})
SET st2.name = 'EBS Database Volume',
    st2.type = 'storage',
    st2.status = 'active',
    st2.environment = 'production',
    st2.external_id = 'vol-0a1b2c3d4e5f6g7h8',
    st2.created_at = datetime(),
    st2.updated_at = datetime(),
    st2.discovered_at = datetime(),
    st2.metadata = '{
      "storage_type": "Block Storage",
      "provider": "AWS EBS",
      "volume_type": "gp3",
      "size_gb": 4000,
      "iops": 16000,
      "throughput_mbps": 1000,
      "encrypted": true,
      "availability_zone": "us-east-1a",
      "tags": ["storage", "block", "database", "production"]
    }';

// ============================================
// RELATIONSHIPS - Define connections between CIs
// ============================================

// Web Frontend relationships
MATCH (app:Application {id: 'app-web-frontend'}), (s1:Server {id: 'srv-prod-web-01'})
MERGE (s1)-[:HOSTS {created_at: datetime()}]->(app);

MATCH (app:Application {id: 'app-web-frontend'}), (s2:Server {id: 'srv-prod-web-02'})
MERGE (s2)-[:HOSTS {created_at: datetime()}]->(app);

MATCH (app:Application {id: 'app-web-frontend'}), (api:Application {id: 'app-api-backend'})
MERGE (app)-[:DEPENDS_ON {created_at: datetime(), dependency_type: 'api'}]->(api);

MATCH (app:Application {id: 'app-web-frontend'}), (lb:NetworkDevice {id: 'net-lb-prod-01'})
MERGE (lb)-[:CONNECTS_TO {created_at: datetime(), port: 3000}]->(app);

// API Backend relationships
MATCH (app:Application {id: 'app-api-backend'}), (s3:Server {id: 'srv-prod-api-01'})
MERGE (s3)-[:HOSTS {created_at: datetime()}]->(app);

MATCH (app:Application {id: 'app-api-backend'}), (db1:Database {id: 'db-neo4j-prod'})
MERGE (app)-[:USES {created_at: datetime(), connection_type: 'bolt'}]->(db1);

MATCH (app:Application {id: 'app-api-backend'}), (db2:Database {id: 'db-postgres-datamart'})
MERGE (app)-[:USES {created_at: datetime(), connection_type: 'postgres'}]->(db2);

MATCH (app:Application {id: 'app-api-backend'}), (db3:Database {id: 'db-redis-cache'})
MERGE (app)-[:USES {created_at: datetime(), connection_type: 'redis'}]->(db3);

MATCH (app:Application {id: 'app-api-backend'}), (svc2:Service {id: 'svc-auth-service'})
MERGE (app)-[:DEPENDS_ON {created_at: datetime(), dependency_type: 'authentication'}]->(svc2);

// Discovery Engine relationships
MATCH (app:Application {id: 'app-discovery-engine'}), (s3:Server {id: 'srv-prod-api-01'})
MERGE (s3)-[:HOSTS {created_at: datetime()}]->(app);

MATCH (app:Application {id: 'app-discovery-engine'}), (db1:Database {id: 'db-neo4j-prod'})
MERGE (app)-[:USES {created_at: datetime(), connection_type: 'bolt'}]->(db1);

MATCH (app:Application {id: 'app-discovery-engine'}), (db3:Database {id: 'db-redis-cache'})
MERGE (app)-[:USES {created_at: datetime(), connection_type: 'queue'}]->(db3);

// ETL Processor relationships
MATCH (app:Application {id: 'app-etl-processor'}), (s3:Server {id: 'srv-prod-api-01'})
MERGE (s3)-[:HOSTS {created_at: datetime()}]->(app);

MATCH (app:Application {id: 'app-etl-processor'}), (db1:Database {id: 'db-neo4j-prod'})
MERGE (app)-[:USES {created_at: datetime(), connection_type: 'bolt'}]->(db1);

MATCH (app:Application {id: 'app-etl-processor'}), (db2:Database {id: 'db-postgres-datamart'})
MERGE (app)-[:USES {created_at: datetime(), connection_type: 'postgres'}]->(db2);

// Database hosting relationships
MATCH (db1:Database {id: 'db-neo4j-prod'}), (s4:Server {id: 'srv-prod-db-01'})
MERGE (s4)-[:HOSTS {created_at: datetime()}]->(db1);

MATCH (db2:Database {id: 'db-postgres-datamart'}), (s4:Server {id: 'srv-prod-db-01'})
MERGE (s4)-[:HOSTS {created_at: datetime()}]->(db2);

MATCH (db3:Database {id: 'db-redis-cache'}), (s4:Server {id: 'srv-prod-db-01'})
MERGE (s4)-[:HOSTS {created_at: datetime()}]->(db3);

// Storage relationships
MATCH (st1:Storage {id: 'sto-s3-backups'}), (s9:Server {id: 'srv-maint-01'})
MERGE (s9)-[:USES {created_at: datetime(), access_type: 'backup'}]->(st1);

MATCH (st1:Storage {id: 'sto-s3-backups'}), (db1:Database {id: 'db-neo4j-prod'})
MERGE (db1)-[:BACKED_UP_BY {created_at: datetime(), frequency: 'daily'}]->(st1);

MATCH (st1:Storage {id: 'sto-s3-backups'}), (db2:Database {id: 'db-postgres-datamart'})
MERGE (db2)-[:BACKED_UP_BY {created_at: datetime(), frequency: 'daily'}]->(st1);

MATCH (st2:Storage {id: 'sto-ebs-db'}), (s4:Server {id: 'srv-prod-db-01'})
MERGE (s4)-[:USES {created_at: datetime(), mount_point: '/data'}]->(st2);

// Network relationships
MATCH (net1:NetworkDevice {id: 'net-lb-prod-01'}), (s1:Server {id: 'srv-prod-web-01'})
MERGE (net1)-[:CONNECTS_TO {created_at: datetime(), port: 80}]->(s1);

MATCH (net1:NetworkDevice {id: 'net-lb-prod-01'}), (s2:Server {id: 'srv-prod-web-02'})
MERGE (net1)-[:CONNECTS_TO {created_at: datetime(), port: 80}]->(s2);

MATCH (net2:NetworkDevice {id: 'net-switch-core-01'}), (s1:Server {id: 'srv-prod-web-01'})
MERGE (s1)-[:CONNECTS_TO {created_at: datetime(), vlan: 100}]->(net2);

MATCH (net2:NetworkDevice {id: 'net-switch-core-01'}), (s3:Server {id: 'srv-prod-api-01'})
MERGE (s3)-[:CONNECTS_TO {created_at: datetime(), vlan: 101}]->(net2);

MATCH (net2:NetworkDevice {id: 'net-switch-core-01'}), (s4:Server {id: 'srv-prod-db-01'})
MERGE (s4)-[:CONNECTS_TO {created_at: datetime(), vlan: 102}]->(net2);

MATCH (net3:NetworkDevice {id: 'net-firewall-01'}), (net2:NetworkDevice {id: 'net-switch-core-01'})
MERGE (net2)-[:CONNECTS_TO {created_at: datetime(), interface: 'trunk'}]->(net3);

MATCH (net4:NetworkDevice {id: 'net-router-edge-01'}), (net3:NetworkDevice {id: 'net-firewall-01'})
MERGE (net3)-[:CONNECTS_TO {created_at: datetime(), interface: 'wan'}]->(net4);

// Service relationships
MATCH (svc1:Service {id: 'svc-api-gateway'}), (s3:Server {id: 'srv-prod-api-01'})
MERGE (s3)-[:HOSTS {created_at: datetime()}]->(svc1);

MATCH (svc3:Service {id: 'svc-metrics-collector'}), (s3:Server {id: 'srv-prod-api-01'})
MERGE (s3)-[:HOSTS {created_at: datetime()}]->(svc3);

MATCH (svc3:Service {id: 'svc-metrics-collector'}), (app1:Application {id: 'app-api-backend'})
MERGE (svc3)-[:CONNECTS_TO {created_at: datetime(), scrape_endpoint: '/metrics'}]->(app1);

// Staging environment relationships
MATCH (s6:Server {id: 'srv-stg-web-01'}), (s7:Server {id: 'srv-stg-api-01'})
MERGE (s6)-[:CONNECTS_TO {created_at: datetime(), environment: 'staging'}]->(s7);

// ============================================
// VERIFICATION QUERIES
// ============================================

// Show all constraints
SHOW CONSTRAINTS;

// Show all indexes
SHOW INDEXES;

// Count nodes by type
MATCH (n:CI) RETURN n.type as type, count(n) as count ORDER BY count DESC;

// Count relationships by type
MATCH ()-[r]->() RETURN type(r) as relationship_type, count(r) as count ORDER BY count DESC;

// Return sample data
MATCH (n:User) RETURN n LIMIT 1;
MATCH (n:CI) RETURN n LIMIT 5;
MATCH (a)-[r]->(b) RETURN a.name, type(r), b.name LIMIT 10;
