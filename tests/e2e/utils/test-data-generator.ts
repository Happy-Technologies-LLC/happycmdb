/**
 * Test Data Generator
 *
 * Utilities for generating realistic test data for E2E tests
 */

import { v4 as uuidv4 } from 'uuid';
import {
  CI,
  CIInput,
  CIType,
  CIStatus,
  Environment,
  Relationship,
  RelationshipType,
} from '../../../packages/common/src/types/ci.types';
import {
  DiscoveryProvider,
  DiscoveredCI,
} from '../../../packages/common/src/types/discovery.types';

/**
 * Generate a random CI
 */
export function generateCI(overrides?: Partial<CIInput>): CIInput {
  const types: CIType[] = [
    'server',
    'virtual-machine',
    'container',
    'application',
    'service',
    'database',
    'network-device',
    'storage',
    'load-balancer',
    'cloud-resource',
  ];

  const statuses: CIStatus[] = ['active', 'inactive', 'maintenance', 'decommissioned'];
  const environments: Environment[] = ['production', 'staging', 'development', 'test'];

  return {
    id: uuidv4(),
    external_id: `ext-${uuidv4()}`,
    name: `test-ci-${randomString(8)}`,
    type: types[Math.floor(Math.random() * types.length)],
    status: statuses[Math.floor(Math.random() * statuses.length)],
    environment: environments[Math.floor(Math.random() * environments.length)],
    discovered_at: new Date().toISOString(),
    metadata: {
      test: true,
      generated: true,
    },
    ...overrides,
  };
}

/**
 * Generate a batch of related CIs
 */
export function generateCIHierarchy(): {
  cis: CIInput[];
  relationships: Relationship[];
} {
  // Create a simple 3-tier application hierarchy
  const loadBalancer = generateCI({
    name: 'test-load-balancer',
    type: 'load-balancer',
    status: 'active',
    environment: 'production',
  });

  const webServer1 = generateCI({
    name: 'test-web-server-1',
    type: 'virtual-machine',
    status: 'active',
    environment: 'production',
  });

  const webServer2 = generateCI({
    name: 'test-web-server-2',
    type: 'virtual-machine',
    status: 'active',
    environment: 'production',
  });

  const appServer1 = generateCI({
    name: 'test-app-server-1',
    type: 'application',
    status: 'active',
    environment: 'production',
  });

  const appServer2 = generateCI({
    name: 'test-app-server-2',
    type: 'application',
    status: 'active',
    environment: 'production',
  });

  const database = generateCI({
    name: 'test-database',
    type: 'database',
    status: 'active',
    environment: 'production',
  });

  const cis = [
    loadBalancer,
    webServer1,
    webServer2,
    appServer1,
    appServer2,
    database,
  ];

  const relationships: Relationship[] = [
    // Load balancer connects to web servers
    {
      from_id: loadBalancer.id,
      to_id: webServer1.id,
      type: 'CONNECTS_TO',
    },
    {
      from_id: loadBalancer.id,
      to_id: webServer2.id,
      type: 'CONNECTS_TO',
    },
    // Web servers host applications
    {
      from_id: webServer1.id,
      to_id: appServer1.id,
      type: 'HOSTS',
    },
    {
      from_id: webServer2.id,
      to_id: appServer2.id,
      type: 'HOSTS',
    },
    // Applications depend on database
    {
      from_id: appServer1.id,
      to_id: database.id,
      type: 'DEPENDS_ON',
    },
    {
      from_id: appServer2.id,
      to_id: database.id,
      type: 'DEPENDS_ON',
    },
  ];

  return { cis, relationships };
}

/**
 * Generate AWS EC2 discovered CIs
 */
export function generateAWSEC2Instances(count: number): DiscoveredCI[] {
  const instances: DiscoveredCI[] = [];

  for (let i = 0; i < count; i++) {
    instances.push({
      id: uuidv4(),
      external_id: `i-${randomHex(17)}`,
      name: `ec2-instance-${i + 1}`,
      type: 'virtual-machine',
      status: 'active',
      environment: 'production',
      discovered_at: new Date().toISOString(),
      discovery_job_id: 'test-job-id',
      discovery_provider: 'aws',
      confidence_score: 0.95,
      metadata: {
        region: 'us-east-1',
        availability_zone: `us-east-1${String.fromCharCode(97 + (i % 3))}`,
        instance_type: 't3.medium',
        state: 'running',
        private_ip: `10.0.${Math.floor(i / 254)}.${(i % 254) + 1}`,
        public_ip: `54.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`,
        launch_time: new Date(Date.now() - Math.random() * 86400000 * 30).toISOString(),
        tags: {
          Name: `ec2-instance-${i + 1}`,
          Environment: 'production',
          Team: 'platform',
        },
      },
    });
  }

  return instances;
}

/**
 * Generate a relationship between two CIs
 */
export function generateRelationship(
  fromId: string,
  toId: string,
  type?: RelationshipType
): Relationship {
  const types: RelationshipType[] = [
    'DEPENDS_ON',
    'HOSTS',
    'CONNECTS_TO',
    'USES',
    'OWNED_BY',
    'PART_OF',
    'LOCATED_IN',
    'DEPLOYED_ON',
    'BACKED_UP_BY',
  ];

  return {
    from_id: fromId,
    to_id: toId,
    type: type || types[Math.floor(Math.random() * types.length)],
    properties: {
      created_at: new Date().toISOString(),
      test: true,
    },
  };
}

/**
 * Wait utility for tests
 */
export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry utility for async operations
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options?: {
    retries?: number;
    delay?: number;
    backoff?: number;
  }
): Promise<T> {
  const retries = options?.retries || 3;
  const delay = options?.delay || 1000;
  const backoff = options?.backoff || 2;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < retries - 1) {
        const waitTime = delay * Math.pow(backoff, attempt);
        await wait(waitTime);
      }
    }
  }

  throw lastError || new Error('Retry failed');
}

/**
 * Generate random string
 */
function randomString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * Generate random hex string
 */
function randomHex(length: number): string {
  const chars = '0123456789abcdef';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}
