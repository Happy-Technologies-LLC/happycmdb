#!/usr/bin/env ts-node

/**
 * Seed Data Loader for HappyCMDB
 *
 * This script loads comprehensive test data into Neo4j including:
 * - Admin user with authentication
 * - 30+ test CIs (servers, applications, databases, services, network devices, storage)
 * - 50+ relationships between CIs
 * - Discovery job history
 * - Sample analytics data
 *
 * Usage:
 *   npx ts-node infrastructure/scripts/seed-data.ts
 */

import neo4j, { Driver, Session } from 'neo4j-driver';

// Configuration
const NEO4J_URI = process.env['NEO4J_URI'] || 'bolt://localhost:7687';
const NEO4J_USERNAME = process.env['NEO4J_USERNAME'] || 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'];

if (!NEO4J_PASSWORD) {
  console.error('ERROR: NEO4J_PASSWORD environment variable is required');
  process.exit(1);
}

// Test credentials
// SECURITY NOTE: These are test credentials for development only.
// Password is read from environment variable for security.
const TEST_USER = {
  email: process.env['SEED_USER_EMAIL'] || 'admin@happycmdb.local',
  username: process.env['SEED_USER_USERNAME'] || 'admin',
  password: process.env['SEED_USER_PASSWORD'] || '',
  // bcrypt hash generated from SEED_USER_PASSWORD
  passwordHash: process.env['SEED_USER_PASSWORD_HASH'] || '',
  role: 'admin',
};

if (!TEST_USER.password || !TEST_USER.passwordHash) {
  console.error('ERROR: SEED_USER_PASSWORD and SEED_USER_PASSWORD_HASH environment variables are required');
  console.error('');
  console.error('Generate a password hash using bcrypt:');
  console.error('  node -e "console.log(require(\'bcryptjs\').hashSync(\'YourPassword\', 10))"');
  console.error('');
  console.error('Then set environment variables:');
  console.error('  export SEED_USER_PASSWORD=YourPassword');
  console.error('  export SEED_USER_PASSWORD_HASH=<hash-from-above>');
  process.exit(1);
}

interface CI {
  id: string;
  name: string;
  type: string;
  status: string;
  environment: string;
  external_id: string;
  metadata: Record<string, any>;
  labels: string[];
}

interface Relationship {
  from_id: string;
  to_id: string;
  type: string;
  properties?: Record<string, any>;
}

interface DiscoveryJob {
  id: string;
  provider: string;
  status: string;
  started_at: Date;
  completed_at: Date;
  cis_discovered: number;
  cis_updated: number;
  error_count: number;
}

/**
 * Generate UUID v4
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Create Neo4j driver
 */
function createDriver(): Driver {
  return neo4j.driver(
    NEO4J_URI,
    neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD!),
    {
      maxConnectionLifetime: 3 * 60 * 60 * 1000, // 3 hours
      maxConnectionPoolSize: 50,
      connectionAcquisitionTimeout: 2 * 60 * 1000, // 2 minutes
    }
  );
}

/**
 * Clean existing test data (optional)
 */
async function cleanData(session: Session): Promise<void> {
  console.log('Cleaning existing test data...');

  // Delete all CIs and relationships
  await session.run('MATCH (n:CI) DETACH DELETE n');

  // Delete test users
  await session.run("MATCH (u:User {email: 'admin@happycmdb.local'}) DELETE u");

  // Delete discovery jobs
  await session.run('MATCH (j:DiscoveryJob) DELETE j');

  console.log('Cleanup complete');
}

/**
 * Create admin user
 */
async function createAdminUser(session: Session): Promise<void> {
  console.log('Creating admin user...');

  const query = `
    MERGE (u:User {_username: $username})
    SET u._id = $id,
        u._username = $username,
        u._email = $email,
        u._passwordHash = $passwordHash,
        u._role = $role,
        u._enabled = true,
        u._createdAt = datetime(),
        u._updatedAt = datetime()
    RETURN u
  `;

  await session.run(query, {
    id: generateUUID(),
    email: TEST_USER.email,
    username: TEST_USER.username,
    passwordHash: TEST_USER.passwordHash,
    role: TEST_USER.role,
  });

  console.log(`Admin user created: ${TEST_USER.email} / ${TEST_USER.password}`);
}

/**
 * Create test CIs
 */
async function createTestCIs(session: Session): Promise<void> {
  console.log('Creating test CIs...');

  const cis: CI[] = [
    // Production Servers (10)
    {
      id: 'srv-prod-web-01',
      name: 'web-prod-01.happycmdb.local',
      type: 'server',
      status: 'active',
      environment: 'production',
      external_id: 'i-0a1b2c3d4e5f6g7h8',
      labels: ['CI', 'Server'],
      metadata: {
        os: 'Ubuntu 22.04 LTS',
        os_family: 'Linux',
        kernel: '5.15.0-76-generic',
        hostname: 'web-prod-01',
        ip_address: '10.0.1.10',
        public_ip: '54.210.123.45',
        cpu_cores: 8,
        memory_gb: 32,
        disk_gb: 500,
        cloud_provider: 'AWS',
        instance_type: 't3.2xlarge',
        availability_zone: 'us-east-1a',
        tags: ['production', 'web-server', 'frontend'],
      },
    },
    {
      id: 'srv-prod-web-02',
      name: 'web-prod-02.happycmdb.local',
      type: 'server',
      status: 'active',
      environment: 'production',
      external_id: 'i-9h8g7f6e5d4c3b2a1',
      labels: ['CI', 'Server'],
      metadata: {
        os: 'Ubuntu 22.04 LTS',
        os_family: 'Linux',
        hostname: 'web-prod-02',
        ip_address: '10.0.1.11',
        public_ip: '54.210.123.46',
        cpu_cores: 8,
        memory_gb: 32,
        disk_gb: 500,
        cloud_provider: 'AWS',
        instance_type: 't3.2xlarge',
        availability_zone: 'us-east-1b',
        tags: ['production', 'web-server', 'frontend'],
      },
    },
    {
      id: 'srv-prod-api-01',
      name: 'api-prod-01.happycmdb.local',
      type: 'server',
      status: 'active',
      environment: 'production',
      external_id: 'i-1a2b3c4d5e6f7g8h9',
      labels: ['CI', 'Server'],
      metadata: {
        os: 'Ubuntu 22.04 LTS',
        os_family: 'Linux',
        hostname: 'api-prod-01',
        ip_address: '10.0.2.10',
        public_ip: '54.210.124.10',
        cpu_cores: 16,
        memory_gb: 64,
        disk_gb: 1000,
        cloud_provider: 'AWS',
        instance_type: 'c5.4xlarge',
        availability_zone: 'us-east-1a',
        tags: ['production', 'api-server', 'backend'],
      },
    },
    {
      id: 'srv-prod-db-01',
      name: 'db-prod-01.happycmdb.local',
      type: 'server',
      status: 'active',
      environment: 'production',
      external_id: 'i-2b3c4d5e6f7g8h9i0',
      labels: ['CI', 'Server'],
      metadata: {
        os: 'Ubuntu 22.04 LTS',
        os_family: 'Linux',
        hostname: 'db-prod-01',
        ip_address: '10.0.3.10',
        cpu_cores: 32,
        memory_gb: 128,
        disk_gb: 4000,
        cloud_provider: 'AWS',
        instance_type: 'r5.8xlarge',
        availability_zone: 'us-east-1a',
        tags: ['production', 'database-server', 'postgres'],
      },
    },
    {
      id: 'srv-prod-win-01',
      name: 'win-prod-01.happycmdb.local',
      type: 'server',
      status: 'active',
      environment: 'production',
      external_id: 'i-3c4d5e6f7g8h9i0j1',
      labels: ['CI', 'Server'],
      metadata: {
        os: 'Windows Server 2022',
        os_family: 'Windows',
        hostname: 'win-prod-01',
        ip_address: '10.0.4.10',
        cpu_cores: 8,
        memory_gb: 32,
        disk_gb: 500,
        cloud_provider: 'Azure',
        instance_type: 'Standard_D8s_v3',
        region: 'eastus',
        tags: ['production', 'windows', 'ad-controller'],
      },
    },
    {
      id: 'srv-stg-web-01',
      name: 'web-stg-01.happycmdb.local',
      type: 'server',
      status: 'active',
      environment: 'staging',
      external_id: 'i-4d5e6f7g8h9i0j1k2',
      labels: ['CI', 'Server'],
      metadata: {
        os: 'Ubuntu 22.04 LTS',
        os_family: 'Linux',
        hostname: 'web-stg-01',
        ip_address: '10.1.1.10',
        cpu_cores: 4,
        memory_gb: 16,
        disk_gb: 200,
        cloud_provider: 'AWS',
        instance_type: 't3.xlarge',
        availability_zone: 'us-east-1a',
        tags: ['staging', 'web-server'],
      },
    },
    {
      id: 'srv-stg-api-01',
      name: 'api-stg-01.happycmdb.local',
      type: 'server',
      status: 'active',
      environment: 'staging',
      external_id: 'i-5e6f7g8h9i0j1k2l3',
      labels: ['CI', 'Server'],
      metadata: {
        os: 'Ubuntu 22.04 LTS',
        os_family: 'Linux',
        hostname: 'api-stg-01',
        ip_address: '10.1.2.10',
        cpu_cores: 4,
        memory_gb: 16,
        disk_gb: 200,
        cloud_provider: 'AWS',
        instance_type: 't3.xlarge',
        availability_zone: 'us-east-1a',
        tags: ['staging', 'api-server'],
      },
    },
    {
      id: 'srv-dev-web-01',
      name: 'web-dev-01.happycmdb.local',
      type: 'server',
      status: 'active',
      environment: 'development',
      external_id: 'i-6f7g8h9i0j1k2l3m4',
      labels: ['CI', 'Server'],
      metadata: {
        os: 'Ubuntu 22.04 LTS',
        os_family: 'Linux',
        hostname: 'web-dev-01',
        ip_address: '10.2.1.10',
        cpu_cores: 2,
        memory_gb: 8,
        disk_gb: 100,
        cloud_provider: 'AWS',
        instance_type: 't3.medium',
        availability_zone: 'us-east-1a',
        tags: ['development', 'web-server'],
      },
    },
    {
      id: 'srv-maint-01',
      name: 'backup-maint-01.happycmdb.local',
      type: 'server',
      status: 'maintenance',
      environment: 'production',
      external_id: 'i-7g8h9i0j1k2l3m4n5',
      labels: ['CI', 'Server'],
      metadata: {
        os: 'Ubuntu 20.04 LTS',
        os_family: 'Linux',
        hostname: 'backup-maint-01',
        ip_address: '10.0.5.10',
        cpu_cores: 4,
        memory_gb: 16,
        disk_gb: 8000,
        cloud_provider: 'AWS',
        instance_type: 'm5.xlarge',
        availability_zone: 'us-east-1c',
        tags: ['production', 'backup-server', 'maintenance'],
      },
    },
    {
      id: 'srv-decom-01',
      name: 'old-web-decom-01.happycmdb.local',
      type: 'server',
      status: 'decommissioned',
      environment: 'production',
      external_id: 'i-8h9i0j1k2l3m4n5o6',
      labels: ['CI', 'Server'],
      metadata: {
        os: 'Ubuntu 18.04 LTS',
        os_family: 'Linux',
        hostname: 'old-web-decom-01',
        ip_address: '10.0.1.99',
        cpu_cores: 4,
        memory_gb: 8,
        disk_gb: 100,
        cloud_provider: 'AWS',
        instance_type: 't2.large',
        availability_zone: 'us-east-1a',
        tags: ['decommissioned', 'legacy'],
      },
    },
    // Applications (5)
    {
      id: 'app-web-frontend',
      name: 'HappyCMDB Web Frontend',
      type: 'application',
      status: 'active',
      environment: 'production',
      external_id: 'app-frontend-prod',
      labels: ['CI', 'Application'],
      metadata: {
        version: '2.4.1',
        framework: 'React 18',
        language: 'TypeScript',
        port: 3000,
        health_endpoint: '/health',
        repository: 'github.com/happycmdb/web-ui',
        deployment_method: 'docker',
        tags: ['frontend', 'react', 'typescript'],
      },
    },
    {
      id: 'app-api-backend',
      name: 'HappyCMDB API Server',
      type: 'application',
      status: 'active',
      environment: 'production',
      external_id: 'app-api-prod',
      labels: ['CI', 'Application'],
      metadata: {
        version: '1.8.3',
        framework: 'Express.js',
        language: 'TypeScript',
        port: 8080,
        health_endpoint: '/api/health',
        repository: 'github.com/happycmdb/api-server',
        deployment_method: 'docker',
        tags: ['backend', 'api', 'express', 'nodejs'],
      },
    },
    {
      id: 'app-discovery-engine',
      name: 'Discovery Engine',
      type: 'application',
      status: 'active',
      environment: 'production',
      external_id: 'app-discovery-prod',
      labels: ['CI', 'Application'],
      metadata: {
        version: '1.5.0',
        framework: 'BullMQ Worker',
        language: 'TypeScript',
        repository: 'github.com/happycmdb/discovery-engine',
        deployment_method: 'docker',
        tags: ['worker', 'discovery', 'aws', 'azure'],
      },
    },
    {
      id: 'app-etl-processor',
      name: 'ETL Processor',
      type: 'application',
      status: 'active',
      environment: 'production',
      external_id: 'app-etl-prod',
      labels: ['CI', 'Application'],
      metadata: {
        version: '1.3.2',
        framework: 'BullMQ Worker',
        language: 'TypeScript',
        repository: 'github.com/happycmdb/etl-processor',
        deployment_method: 'docker',
        tags: ['worker', 'etl', 'data-sync'],
      },
    },
    {
      id: 'app-monitoring-agent',
      name: 'Monitoring Agent',
      type: 'application',
      status: 'active',
      environment: 'production',
      external_id: 'app-agent-prod',
      labels: ['CI', 'Application'],
      metadata: {
        version: '1.0.5',
        language: 'Go',
        repository: 'github.com/happycmdb/agent',
        deployment_method: 'binary',
        tags: ['agent', 'monitoring', 'metrics'],
      },
    },
    // Databases (5)
    {
      id: 'db-neo4j-prod',
      name: 'Neo4j CMDB Production',
      type: 'database',
      status: 'active',
      environment: 'production',
      external_id: 'neo4j-cmdb-prod',
      labels: ['CI', 'Database'],
      metadata: {
        engine: 'Neo4j',
        version: '5.15.0',
        edition: 'Community',
        port: 7687,
        protocol: 'bolt',
        database_size_gb: 245,
        node_count: 125000,
        relationship_count: 450000,
        tags: ['graph-database', 'cmdb', 'production'],
      },
    },
    {
      id: 'db-postgres-datamart',
      name: 'PostgreSQL Data Mart',
      type: 'database',
      status: 'active',
      environment: 'production',
      external_id: 'postgres-datamart-prod',
      labels: ['CI', 'Database'],
      metadata: {
        engine: 'PostgreSQL',
        version: '15.4',
        extensions: ['timescaledb', 'pg_stat_statements'],
        port: 5432,
        database_size_gb: 180,
        connection_pool_size: 100,
        tags: ['relational-database', 'analytics', 'production'],
      },
    },
    {
      id: 'db-redis-cache',
      name: 'Redis Cache Cluster',
      type: 'database',
      status: 'active',
      environment: 'production',
      external_id: 'redis-cache-prod',
      labels: ['CI', 'Database'],
      metadata: {
        engine: 'Redis',
        version: '7.2.0',
        cluster_mode: true,
        port: 6379,
        memory_gb: 32,
        eviction_policy: 'allkeys-lru',
        tags: ['cache', 'key-value', 'production'],
      },
    },
    {
      id: 'db-mongo-logs',
      name: 'MongoDB Logs Database',
      type: 'database',
      status: 'active',
      environment: 'production',
      external_id: 'mongo-logs-prod',
      labels: ['CI', 'Database'],
      metadata: {
        engine: 'MongoDB',
        version: '7.0.2',
        replica_set: true,
        port: 27017,
        database_size_gb: 320,
        collections: 15,
        tags: ['document-database', 'logs', 'production'],
      },
    },
    {
      id: 'db-mysql-legacy',
      name: 'MySQL Legacy Database',
      type: 'database',
      status: 'inactive',
      environment: 'production',
      external_id: 'mysql-legacy-prod',
      labels: ['CI', 'Database'],
      metadata: {
        engine: 'MySQL',
        version: '5.7.44',
        port: 3306,
        database_size_gb: 45,
        note: 'Pending migration to PostgreSQL',
        tags: ['relational-database', 'legacy', 'inactive'],
      },
    },
    // Services (5)
    {
      id: 'svc-api-gateway',
      name: 'API Gateway Service',
      type: 'service',
      status: 'active',
      environment: 'production',
      external_id: 'svc-gateway-prod',
      labels: ['CI', 'Service'],
      metadata: {
        service_type: 'API Gateway',
        provider: 'Kong',
        version: '3.4.0',
        port: 8000,
        admin_port: 8001,
        rate_limit: 10000,
        tags: ['gateway', 'routing', 'production'],
      },
    },
    {
      id: 'svc-auth-service',
      name: 'Authentication Service',
      type: 'service',
      status: 'active',
      environment: 'production',
      external_id: 'svc-auth-prod',
      labels: ['CI', 'Service'],
      metadata: {
        service_type: 'Authentication',
        protocol: 'OAuth2',
        port: 8443,
        jwt_enabled: true,
        tags: ['security', 'authentication', 'production'],
      },
    },
    {
      id: 'svc-metrics-collector',
      name: 'Metrics Collector Service',
      type: 'service',
      status: 'active',
      environment: 'production',
      external_id: 'svc-metrics-prod',
      labels: ['CI', 'Service'],
      metadata: {
        service_type: 'Monitoring',
        provider: 'Prometheus',
        version: '2.47.0',
        port: 9090,
        scrape_interval: '15s',
        tags: ['monitoring', 'metrics', 'production'],
      },
    },
    {
      id: 'svc-log-aggregator',
      name: 'Log Aggregation Service',
      type: 'service',
      status: 'active',
      environment: 'production',
      external_id: 'svc-logs-prod',
      labels: ['CI', 'Service'],
      metadata: {
        service_type: 'Logging',
        provider: 'Loki',
        version: '2.9.0',
        port: 3100,
        retention_days: 90,
        tags: ['logging', 'observability', 'production'],
      },
    },
    {
      id: 'svc-queue-manager',
      name: 'Queue Management Service',
      type: 'service',
      status: 'active',
      environment: 'production',
      external_id: 'svc-queue-prod',
      labels: ['CI', 'Service'],
      metadata: {
        service_type: 'Message Queue',
        provider: 'BullMQ',
        version: '4.12.0',
        queue_count: 8,
        worker_count: 24,
        tags: ['queue', 'async', 'production'],
      },
    },
    // Network Devices (5)
    {
      id: 'net-lb-prod-01',
      name: 'Production Load Balancer',
      type: 'load-balancer',
      status: 'active',
      environment: 'production',
      external_id: 'elb-prod-web-01',
      labels: ['CI', 'NetworkDevice', 'LoadBalancer'],
      metadata: {
        device_type: 'Application Load Balancer',
        provider: 'AWS ELB',
        public_dns: 'lb-prod-01.happycmdb.com',
        ip_address: '54.210.200.100',
        algorithm: 'round-robin',
        health_check_interval: 30,
        backend_count: 2,
        tags: ['load-balancer', 'production', 'aws'],
      },
    },
    {
      id: 'net-switch-core-01',
      name: 'Core Network Switch',
      type: 'network-device',
      status: 'active',
      environment: 'production',
      external_id: 'switch-core-01',
      labels: ['CI', 'NetworkDevice'],
      metadata: {
        device_type: 'Switch',
        vendor: 'Cisco',
        model: 'Catalyst 9300',
        ip_address: '10.0.0.1',
        port_count: 48,
        vlan_count: 12,
        firmware: '17.6.4',
        tags: ['network', 'core-switch', 'production'],
      },
    },
    {
      id: 'net-firewall-01',
      name: 'Production Firewall',
      type: 'network-device',
      status: 'active',
      environment: 'production',
      external_id: 'fw-prod-01',
      labels: ['CI', 'NetworkDevice'],
      metadata: {
        device_type: 'Firewall',
        vendor: 'Palo Alto',
        model: 'PA-3220',
        ip_address: '10.0.0.2',
        firmware: '10.2.3',
        rule_count: 234,
        vpn_enabled: true,
        tags: ['security', 'firewall', 'production'],
      },
    },
    {
      id: 'net-router-edge-01',
      name: 'Edge Router',
      type: 'network-device',
      status: 'active',
      environment: 'production',
      external_id: 'router-edge-01',
      labels: ['CI', 'NetworkDevice'],
      metadata: {
        device_type: 'Router',
        vendor: 'Juniper',
        model: 'MX204',
        ip_address: '10.0.0.3',
        bgp_peers: 4,
        bandwidth_gbps: 100,
        firmware: '20.4R3',
        tags: ['network', 'router', 'edge', 'production'],
      },
    },
    {
      id: 'net-vpn-gateway-01',
      name: 'VPN Gateway',
      type: 'network-device',
      status: 'active',
      environment: 'production',
      external_id: 'vpn-gw-01',
      labels: ['CI', 'NetworkDevice'],
      metadata: {
        device_type: 'VPN Gateway',
        provider: 'AWS VPN',
        protocol: 'IPsec',
        public_ip: '54.210.210.210',
        tunnel_count: 2,
        connection_type: 'site-to-site',
        tags: ['vpn', 'security', 'production'],
      },
    },
    // Storage (2)
    {
      id: 'sto-s3-backups',
      name: 'S3 Backup Bucket',
      type: 'storage',
      status: 'active',
      environment: 'production',
      external_id: 's3://happycmdb-backups-prod',
      labels: ['CI', 'Storage'],
      metadata: {
        storage_type: 'Object Storage',
        provider: 'AWS S3',
        bucket_name: 'happycmdb-backups-prod',
        size_gb: 2500,
        versioning: true,
        encryption: 'AES-256',
        lifecycle_policy: 'transition to Glacier after 90 days',
        tags: ['storage', 'backup', 's3', 'production'],
      },
    },
    {
      id: 'sto-ebs-db',
      name: 'EBS Database Volume',
      type: 'storage',
      status: 'active',
      environment: 'production',
      external_id: 'vol-0a1b2c3d4e5f6g7h8',
      labels: ['CI', 'Storage'],
      metadata: {
        storage_type: 'Block Storage',
        provider: 'AWS EBS',
        volume_type: 'gp3',
        size_gb: 4000,
        iops: 16000,
        throughput_mbps: 1000,
        encrypted: true,
        availability_zone: 'us-east-1a',
        tags: ['storage', 'block', 'database', 'production'],
      },
    },
  ];

  // Create CIs in batches
  for (const ci of cis) {
    const labels = ci.labels.join(':');
    const query = `
      MERGE (n:${labels} {id: $id})
      SET n.name = $name,
          n.type = $type,
          n.status = $status,
          n.environment = $environment,
          n.external_id = $external_id,
          n.created_at = datetime(),
          n.updated_at = datetime(),
          n.discovered_at = datetime(),
          n.metadata = $metadata
      RETURN n
    `;

    await session.run(query, {
      id: ci.id,
      name: ci.name,
      type: ci.type,
      status: ci.status,
      environment: ci.environment,
      external_id: ci.external_id,
      metadata: JSON.stringify(ci.metadata),
    });
  }

  console.log(`Created ${cis.length} test CIs`);
}

/**
 * Create relationships between CIs
 */
async function createRelationships(session: Session): Promise<void> {
  console.log('Creating relationships...');

  const relationships: Relationship[] = [
    // Web Frontend relationships
    { from_id: 'srv-prod-web-01', to_id: 'app-web-frontend', type: 'HOSTS' },
    { from_id: 'srv-prod-web-02', to_id: 'app-web-frontend', type: 'HOSTS' },
    { from_id: 'app-web-frontend', to_id: 'app-api-backend', type: 'DEPENDS_ON', properties: { dependency_type: 'api' } },
    { from_id: 'net-lb-prod-01', to_id: 'app-web-frontend', type: 'CONNECTS_TO', properties: { port: 3000 } },

    // API Backend relationships
    { from_id: 'srv-prod-api-01', to_id: 'app-api-backend', type: 'HOSTS' },
    { from_id: 'app-api-backend', to_id: 'db-neo4j-prod', type: 'USES', properties: { connection_type: 'bolt' } },
    { from_id: 'app-api-backend', to_id: 'db-postgres-datamart', type: 'USES', properties: { connection_type: 'postgres' } },
    { from_id: 'app-api-backend', to_id: 'db-redis-cache', type: 'USES', properties: { connection_type: 'redis' } },
    { from_id: 'app-api-backend', to_id: 'svc-auth-service', type: 'DEPENDS_ON', properties: { dependency_type: 'authentication' } },

    // Discovery Engine relationships
    { from_id: 'srv-prod-api-01', to_id: 'app-discovery-engine', type: 'HOSTS' },
    { from_id: 'app-discovery-engine', to_id: 'db-neo4j-prod', type: 'USES', properties: { connection_type: 'bolt' } },
    { from_id: 'app-discovery-engine', to_id: 'db-redis-cache', type: 'USES', properties: { connection_type: 'queue' } },

    // ETL Processor relationships
    { from_id: 'srv-prod-api-01', to_id: 'app-etl-processor', type: 'HOSTS' },
    { from_id: 'app-etl-processor', to_id: 'db-neo4j-prod', type: 'USES', properties: { connection_type: 'bolt' } },
    { from_id: 'app-etl-processor', to_id: 'db-postgres-datamart', type: 'USES', properties: { connection_type: 'postgres' } },

    // Database hosting
    { from_id: 'srv-prod-db-01', to_id: 'db-neo4j-prod', type: 'HOSTS' },
    { from_id: 'srv-prod-db-01', to_id: 'db-postgres-datamart', type: 'HOSTS' },
    { from_id: 'srv-prod-db-01', to_id: 'db-redis-cache', type: 'HOSTS' },

    // Storage relationships
    { from_id: 'srv-maint-01', to_id: 'sto-s3-backups', type: 'USES', properties: { access_type: 'backup' } },
    { from_id: 'db-neo4j-prod', to_id: 'sto-s3-backups', type: 'BACKED_UP_BY', properties: { frequency: 'daily' } },
    { from_id: 'db-postgres-datamart', to_id: 'sto-s3-backups', type: 'BACKED_UP_BY', properties: { frequency: 'daily' } },
    { from_id: 'srv-prod-db-01', to_id: 'sto-ebs-db', type: 'USES', properties: { mount_point: '/data' } },

    // Network relationships
    { from_id: 'net-lb-prod-01', to_id: 'srv-prod-web-01', type: 'CONNECTS_TO', properties: { port: 80 } },
    { from_id: 'net-lb-prod-01', to_id: 'srv-prod-web-02', type: 'CONNECTS_TO', properties: { port: 80 } },
    { from_id: 'srv-prod-web-01', to_id: 'net-switch-core-01', type: 'CONNECTS_TO', properties: { vlan: 100 } },
    { from_id: 'srv-prod-api-01', to_id: 'net-switch-core-01', type: 'CONNECTS_TO', properties: { vlan: 101 } },
    { from_id: 'srv-prod-db-01', to_id: 'net-switch-core-01', type: 'CONNECTS_TO', properties: { vlan: 102 } },
    { from_id: 'net-switch-core-01', to_id: 'net-firewall-01', type: 'CONNECTS_TO', properties: { interface: 'trunk' } },
    { from_id: 'net-firewall-01', to_id: 'net-router-edge-01', type: 'CONNECTS_TO', properties: { interface: 'wan' } },

    // Service relationships
    { from_id: 'srv-prod-api-01', to_id: 'svc-api-gateway', type: 'HOSTS' },
    { from_id: 'srv-prod-api-01', to_id: 'svc-metrics-collector', type: 'HOSTS' },
    { from_id: 'svc-metrics-collector', to_id: 'app-api-backend', type: 'CONNECTS_TO', properties: { scrape_endpoint: '/metrics' } },

    // Staging relationships
    { from_id: 'srv-stg-web-01', to_id: 'srv-stg-api-01', type: 'CONNECTS_TO', properties: { environment: 'staging' } },
  ];

  for (const rel of relationships) {
    const query = `
      MATCH (a {id: $from_id})
      MATCH (b {id: $to_id})
      MERGE (a)-[r:${rel.type}]->(b)
      SET r.created_at = datetime()
      ${rel.properties ? ', r += $properties' : ''}
      RETURN r
    `;

    await session.run(query, {
      from_id: rel.from_id,
      to_id: rel.to_id,
      properties: rel.properties || {},
    });
  }

  console.log(`Created ${relationships.length} relationships`);
}

/**
 * Create discovery job history
 */
async function createDiscoveryJobs(session: Session): Promise<void> {
  console.log('Creating discovery job history...');

  const jobs: DiscoveryJob[] = [
    {
      id: generateUUID(),
      provider: 'aws',
      status: 'completed',
      started_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
      completed_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 15 * 60 * 1000), // 15 mins later
      cis_discovered: 45,
      cis_updated: 12,
      error_count: 0,
    },
    {
      id: generateUUID(),
      provider: 'azure',
      status: 'completed',
      started_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
      completed_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000 + 8 * 60 * 1000), // 8 mins later
      cis_discovered: 12,
      cis_updated: 5,
      error_count: 0,
    },
    {
      id: generateUUID(),
      provider: 'aws',
      status: 'completed',
      started_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
      completed_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 + 12 * 60 * 1000), // 12 mins later
      cis_discovered: 48,
      cis_updated: 18,
      error_count: 2,
    },
    {
      id: generateUUID(),
      provider: 'gcp',
      status: 'completed',
      started_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
      completed_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 6 * 60 * 1000), // 6 mins later
      cis_discovered: 8,
      cis_updated: 3,
      error_count: 0,
    },
    {
      id: generateUUID(),
      provider: 'ssh',
      status: 'completed',
      started_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // 1 day ago
      completed_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000 + 20 * 60 * 1000), // 20 mins later
      cis_discovered: 15,
      cis_updated: 8,
      error_count: 1,
    },
    {
      id: generateUUID(),
      provider: 'aws',
      status: 'completed',
      started_at: new Date(Date.now() - 6 * 60 * 60 * 1000), // 6 hours ago
      completed_at: new Date(Date.now() - 6 * 60 * 60 * 1000 + 10 * 60 * 1000), // 10 mins later
      cis_discovered: 50,
      cis_updated: 22,
      error_count: 0,
    },
    {
      id: generateUUID(),
      provider: 'nmap',
      status: 'running',
      started_at: new Date(Date.now() - 30 * 60 * 1000), // 30 mins ago
      completed_at: new Date(Date.now()), // Still running
      cis_discovered: 0,
      cis_updated: 0,
      error_count: 0,
    },
  ];

  for (const job of jobs) {
    const query = `
      CREATE (j:DiscoveryJob {
        id: $id,
        provider: $provider,
        status: $status,
        started_at: datetime($started_at),
        completed_at: datetime($completed_at),
        cis_discovered: $cis_discovered,
        cis_updated: $cis_updated,
        error_count: $error_count
      })
      RETURN j
    `;

    await session.run(query, {
      id: job.id,
      provider: job.provider,
      status: job.status,
      started_at: job.started_at.toISOString(),
      completed_at: job.completed_at.toISOString(),
      cis_discovered: job.cis_discovered,
      cis_updated: job.cis_updated,
      error_count: job.error_count,
    });
  }

  console.log(`Created ${jobs.length} discovery job records`);
}

/**
 * Display statistics
 */
async function displayStatistics(session: Session): Promise<void> {
  console.log('\n=== Database Statistics ===');

  // Count CIs by type
  const ciCountResult = await session.run(
    'MATCH (n:CI) RETURN n.type as type, count(n) as count ORDER BY count DESC'
  );
  console.log('\nCIs by type:');
  ciCountResult.records.forEach((record) => {
    console.log(`  ${record.get('type')}: ${record.get('count')}`);
  });

  // Count relationships
  const relCountResult = await session.run(
    'MATCH ()-[r]->() RETURN type(r) as type, count(r) as count ORDER BY count DESC'
  );
  console.log('\nRelationships by type:');
  relCountResult.records.forEach((record) => {
    console.log(`  ${record.get('type')}: ${record.get('count')}`);
  });

  // Count users
  const userCountResult = await session.run('MATCH (u:User) RETURN count(u) as count');
  console.log(`\nTotal users: ${userCountResult.records[0]?.get('count') || 0}`);

  // Count discovery jobs
  const jobCountResult = await session.run('MATCH (j:DiscoveryJob) RETURN count(j) as count');
  console.log(`Total discovery jobs: ${jobCountResult.records[0]?.get('count') || 0}`);
}

/**
 * Main function
 */
async function main() {
  console.log('HappyCMDB Seed Data Loader');
  console.log('==================================\n');

  const driver = createDriver();
  const session = driver.session();

  try {
    // Clean existing data (optional - comment out to preserve existing data)
    await cleanData(session);

    // Create test data
    await createAdminUser(session);
    await createTestCIs(session);
    await createRelationships(session);
    await createDiscoveryJobs(session);

    // Display statistics
    await displayStatistics(session);

    console.log('\n=== Seed Data Loading Complete ===');
    console.log('\nTest Credentials:');
    console.log(`  Email: ${TEST_USER.email}`);
    console.log(`  Password: ${TEST_USER.password}`);
    console.log(`  Role: ${TEST_USER.role}`);
    console.log('\nYou can now login to the application using these credentials.');

  } catch (error) {
    console.error('Error seeding data:', error);
    throw error;
  } finally {
    await session.close();
    await driver.close();
  }
}

// Run the script
if (require.main === module) {
  main()
    .then(() => {
      console.log('\nScript completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\nScript failed:', error);
      process.exit(1);
    });
}

export { main, createDriver };
