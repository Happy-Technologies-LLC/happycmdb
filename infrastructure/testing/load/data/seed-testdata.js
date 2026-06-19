/**
 * Test Data Seeding Script for Load Testing
 *
 * Generates realistic test data for load testing scenarios
 *
 * Run: node seed-testdata.js
 */

const http = require('http');
const https = require('https');

// Configuration
const API_URL = process.env.API_URL || 'http://localhost:3000';
const API_VERSION = '/api/v1';
const USERNAME = process.env.TEST_USERNAME || 'loadtest';
const PASSWORD = process.env.TEST_PASSWORD || 'loadtest123';

// Test data configuration
const CONFIG = {
  ciCount: parseInt(process.env.CI_COUNT || '10000', 10),
  relationshipDensity: parseFloat(process.env.REL_DENSITY || '0.3'), // 30% of CIs have relationships
  ciTypes: ['server', 'application', 'database', 'container', 'service', 'network-device', 'load-balancer'],
  environments: ['production', 'staging', 'development', 'test'],
  statuses: ['active', 'inactive', 'maintenance'],
  batchSize: 100, // Create CIs in batches
};

// Helper to make HTTP requests
function makeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_URL}${path}`);
    const protocol = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (global.authToken) {
      options.headers['Authorization'] = `Bearer ${global.authToken}`;
    }

    const req = protocol.request(options, (res) => {
      let body = '';

      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          resolve({ status: res.statusCode, data: response });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

// Authenticate and get token
async function authenticate() {
  console.log('Authenticating...');

  try {
    const response = await makeRequest('POST', `${API_VERSION}/auth/login`, {
      username: USERNAME,
      password: PASSWORD,
    });

    if (response.status === 200 && response.data.token) {
      global.authToken = response.data.token;
      console.log('✓ Authentication successful');
      return true;
    } else {
      console.error('✗ Authentication failed:', response);
      return false;
    }
  } catch (error) {
    console.error('✗ Authentication error:', error.message);
    return false;
  }
}

// Create test user if doesn't exist
async function createTestUser() {
  console.log('Creating test user...');

  try {
    const response = await makeRequest('POST', `${API_VERSION}/auth/register`, {
      username: USERNAME,
      password: PASSWORD,
      email: 'loadtest@example.com',
      role: 'admin',
    });

    if (response.status === 201) {
      console.log('✓ Test user created');
      return true;
    } else if (response.status === 409) {
      console.log('✓ Test user already exists');
      return true;
    } else {
      console.error('✗ Failed to create test user:', response);
      return false;
    }
  } catch (error) {
    console.error('✗ Error creating test user:', error.message);
    return false;
  }
}

// Generate random CI data
function generateCI(index) {
  const ciType = CONFIG.ciTypes[Math.floor(Math.random() * CONFIG.ciTypes.length)];
  const environment = CONFIG.environments[Math.floor(Math.random() * CONFIG.environments.length)];
  const status = CONFIG.statuses[Math.floor(Math.random() * CONFIG.statuses.length)];

  return {
    ci_name: `loadtest-${ciType}-${index}`,
    ci_type: ciType,
    status: status,
    environment: environment,
    metadata: {
      loadtest: true,
      index: index,
      team: `team-${Math.floor(Math.random() * 10) + 1}`,
      owner: `user-${Math.floor(Math.random() * 100) + 1}`,
      cost_center: `cc-${Math.floor(Math.random() * 9000) + 1000}`,
      region: ['us-east-1', 'us-west-2', 'eu-west-1'][Math.floor(Math.random() * 3)],
    },
  };
}

// Create CIs in batches
async function createCIsBatch(startIndex, count) {
  const cis = [];

  for (let i = 0; i < count; i++) {
    cis.push(generateCI(startIndex + i));
  }

  try {
    const response = await makeRequest('POST', `${API_VERSION}/cis/bulk`, { cis });

    if (response.status === 201) {
      return response.data.data?.created_count || count;
    } else {
      console.error(`✗ Batch creation failed (${startIndex}-${startIndex + count}):`, response);
      return 0;
    }
  } catch (error) {
    console.error(`✗ Batch creation error (${startIndex}-${startIndex + count}):`, error.message);
    return 0;
  }
}

// Create CIs
async function seedCIs() {
  console.log(`\nSeeding ${CONFIG.ciCount} CIs...`);

  const batches = Math.ceil(CONFIG.ciCount / CONFIG.batchSize);
  let totalCreated = 0;

  for (let i = 0; i < batches; i++) {
    const startIndex = i * CONFIG.batchSize;
    const count = Math.min(CONFIG.batchSize, CONFIG.ciCount - startIndex);

    const created = await createCIsBatch(startIndex, count);
    totalCreated += created;

    const progress = ((i + 1) / batches * 100).toFixed(1);
    process.stdout.write(`\r  Progress: ${progress}% (${totalCreated}/${CONFIG.ciCount} CIs created)`);

    // Small delay to avoid overwhelming the API
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`\n✓ Created ${totalCreated} CIs`);
  return totalCreated;
}

// Create relationships between CIs
async function seedRelationships(ciCount) {
  console.log('\nSeeding relationships...');

  const relationshipTypes = [
    'DEPENDS_ON',
    'HOSTS',
    'CONNECTS_TO',
    'USES',
    'OWNED_BY',
  ];

  const relationshipCount = Math.floor(ciCount * CONFIG.relationshipDensity);
  let created = 0;

  for (let i = 0; i < relationshipCount; i++) {
    const sourceId = Math.floor(Math.random() * ciCount) + 1;
    const targetId = Math.floor(Math.random() * ciCount) + 1;

    if (sourceId === targetId) continue; // Skip self-references

    const relType = relationshipTypes[Math.floor(Math.random() * relationshipTypes.length)];

    try {
      const response = await makeRequest('POST', `${API_VERSION}/relationships`, {
        source_ci_id: sourceId,
        target_ci_id: targetId,
        relationship_type: relType,
        metadata: {
          loadtest: true,
        },
      });

      if (response.status === 201) {
        created++;
      }
    } catch (error) {
      // Ignore errors (CI might not exist, relationship might be duplicate)
    }

    if (i % 100 === 0) {
      const progress = ((i + 1) / relationshipCount * 100).toFixed(1);
      process.stdout.write(`\r  Progress: ${progress}% (${created}/${relationshipCount} relationships created)`);
    }
  }

  console.log(`\n✓ Created ${created} relationships`);
  return created;
}

// Create discovery definitions for testing
async function seedDiscoveryDefinitions() {
  console.log('\nSeeding discovery definitions...');

  const connectors = [
    'aws-ec2',
    'aws-s3',
    'azure-vms',
    'gcp-compute',
    'kubernetes',
    'docker',
  ];

  let created = 0;

  for (const connectorId of connectors) {
    try {
      const response = await makeRequest('POST', `${API_VERSION}/discovery/definitions`, {
        name: `loadtest-${connectorId}`,
        connector_id: connectorId,
        enabled: true,
        schedule: '0 0 * * *',
        config: {
          region: 'us-east-1',
          scan_type: 'full',
        },
      });

      if (response.status === 201) {
        created++;
      }
    } catch (error) {
      // Ignore errors (definition might already exist)
    }
  }

  console.log(`✓ Created ${created} discovery definitions`);
  return created;
}

// Main seeding function
async function main() {
  console.log('='.repeat(60));
  console.log('HappyCMDB Load Test Data Seeding');
  console.log('='.repeat(60));
  console.log(`\nConfiguration:`);
  console.log(`  API URL: ${API_URL}`);
  console.log(`  CIs to create: ${CONFIG.ciCount}`);
  console.log(`  Relationship density: ${(CONFIG.relationshipDensity * 100).toFixed(0)}%`);
  console.log(`  Batch size: ${CONFIG.batchSize}`);

  // Step 1: Create test user
  await createTestUser();

  // Step 2: Authenticate
  const authenticated = await authenticate();
  if (!authenticated) {
    console.error('\n✗ Failed to authenticate. Exiting.');
    process.exit(1);
  }

  // Step 3: Seed CIs
  const ciCount = await seedCIs();

  // Step 4: Seed relationships
  await seedRelationships(ciCount);

  // Step 5: Seed discovery definitions
  await seedDiscoveryDefinitions();

  console.log('\n' + '='.repeat(60));
  console.log('✓ Test data seeding completed');
  console.log('='.repeat(60));
}

// Run
main().catch((error) => {
  console.error('\n✗ Seeding failed:', error);
  process.exit(1);
});
