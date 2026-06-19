/**
 * HappyCMDB Discovery Operations Load Test
 *
 * Tests discovery job execution, connector performance, and CI persistence throughput
 *
 * Scenarios:
 * - Sequential discovery jobs (baseline)
 * - Parallel discovery jobs (concurrent connectors)
 * - High-volume CI ingestion (1000+ CIs)
 * - Mixed connector types (API-based vs network-based)
 *
 * Run: k6 run --out json=reports/discovery-results.json scripts/discovery-jobs.js
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';
import { randomString, randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// Custom metrics
const discoveryJobsCreated = new Counter('discovery_jobs_created');
const discoveryJobsCompleted = new Counter('discovery_jobs_completed');
const discoveryJobsFailed = new Counter('discovery_jobs_failed');
const cisDiscovered = new Counter('cis_discovered');
const relationshipsCreated = new Counter('relationships_created');
const discoveryJobDuration = new Trend('discovery_job_duration_ms');
const concurrentJobs = new Gauge('concurrent_jobs');
const ciPersistenceRate = new Trend('ci_persistence_rate_per_sec');

// Configuration
const BASE_URL = __ENV.API_URL || 'http://localhost:3000';
const API_VERSION = '/api/v1';

// Performance thresholds
export const options = {
  scenarios: {
    // Baseline - Sequential discovery jobs
    sequential_discovery: {
      executor: 'constant-vus',
      vus: 5,
      duration: '5m',
      tags: { test_type: 'sequential' },
      exec: 'sequentialDiscovery',
    },

    // Parallel - Concurrent discovery jobs
    parallel_discovery: {
      executor: 'ramping-vus',
      startTime: '5m30s',
      stages: [
        { duration: '1m', target: 10 },
        { duration: '2m', target: 20 },
        { duration: '2m', target: 30 },
        { duration: '1m', target: 0 },
      ],
      tags: { test_type: 'parallel' },
      exec: 'parallelDiscovery',
    },

    // High-volume - Large CI ingestion
    high_volume_ingestion: {
      executor: 'ramping-vus',
      startTime: '12m',
      stages: [
        { duration: '2m', target: 50 },
        { duration: '3m', target: 50 },
        { duration: '1m', target: 0 },
      ],
      tags: { test_type: 'high_volume' },
      exec: 'highVolumeIngestion',
    },
  },

  thresholds: {
    // Discovery job success rate > 95%
    'discovery_jobs_failed': ['rate<0.05'],

    // Discovery job duration
    'discovery_job_duration_ms': [
      'p(50)<30000',  // 50% complete in < 30s
      'p(95)<120000', // 95% complete in < 2 minutes
      'p(99)<300000', // 99% complete in < 5 minutes
    ],

    // CI persistence rate (CIs per second)
    'ci_persistence_rate_per_sec': [
      'avg>10',   // Average 10+ CIs/sec
      'p(95)>5',  // p95 at least 5 CIs/sec
    ],

    // Overall performance
    'http_req_duration': ['p(95)<2000'],
    'http_req_failed': ['rate<0.01'],
  },
};

// Connector configurations for testing
const CONNECTORS = [
  { id: 'aws-ec2', type: 'api', avg_ci_count: 50 },
  { id: 'aws-s3', type: 'api', avg_ci_count: 100 },
  { id: 'azure-vms', type: 'api', avg_ci_count: 40 },
  { id: 'gcp-compute', type: 'api', avg_ci_count: 30 },
  { id: 'kubernetes', type: 'api', avg_ci_count: 200 },
  { id: 'docker', type: 'api', avg_ci_count: 150 },
  { id: 'nmap', type: 'network', avg_ci_count: 25 },
  { id: 'ssh-linux', type: 'network', avg_ci_count: 20 },
];

// Authentication helper
function getAuthToken() {
  const loginRes = http.post(`${BASE_URL}${API_VERSION}/auth/login`, JSON.stringify({
    username: 'loadtest',
    password: 'loadtest123',
  }), {
    headers: { 'Content-Type': 'application/json' },
  });

  return loginRes.json('token');
}

// Create discovery definition
function createDiscoveryDefinition(connectorId, token) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  const definition = {
    name: `loadtest-${connectorId}-${randomString(6)}`,
    connector_id: connectorId,
    enabled: true,
    schedule: '0 0 * * *', // Daily at midnight (won't run during test)
    config: {
      region: 'us-east-1',
      scan_type: 'full',
    },
  };

  const res = http.post(
    `${BASE_URL}${API_VERSION}/discovery/definitions`,
    JSON.stringify(definition),
    { headers, tags: { operation: 'create_definition' } }
  );

  const success = check(res, {
    'definition created': (r) => r.status === 201,
    'definition has ID': (r) => r.json('data.definition_id') !== undefined,
  });

  return success ? res.json('data.definition_id') : null;
}

// Trigger discovery job
function triggerDiscoveryJob(definitionId, token) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  const startTime = Date.now();

  const res = http.post(
    `${BASE_URL}${API_VERSION}/discovery/definitions/${definitionId}/run`,
    null,
    { headers, tags: { operation: 'trigger_job' } }
  );

  const success = check(res, {
    'job triggered': (r) => r.status === 201 || r.status === 202,
    'job has ID': (r) => r.json('data.job_id') !== undefined,
  });

  if (success) {
    discoveryJobsCreated.add(1);
    return {
      jobId: res.json('data.job_id'),
      startTime,
    };
  }

  return null;
}

// Poll job status until complete
function waitForJobCompletion(jobId, token, maxWaitMs = 300000) {
  const headers = {
    'Authorization': `Bearer ${token}`,
  };

  const pollStartTime = Date.now();
  let status = 'running';
  let attempts = 0;
  const maxAttempts = maxWaitMs / 2000; // Poll every 2 seconds

  while (status === 'running' || status === 'pending') {
    if (attempts >= maxAttempts) {
      discoveryJobsFailed.add(1);
      return { status: 'timeout', ciCount: 0, relationshipCount: 0 };
    }

    sleep(2); // Poll every 2 seconds

    const res = http.get(
      `${BASE_URL}${API_VERSION}/discovery/jobs/${jobId}`,
      { headers, tags: { operation: 'poll_job' } }
    );

    if (res.status === 200) {
      const jobData = res.json('data');
      status = jobData.status;

      if (status === 'completed') {
        const duration = Date.now() - pollStartTime;
        discoveryJobDuration.add(duration);
        discoveryJobsCompleted.add(1);

        const ciCount = jobData.cis_discovered || 0;
        const relationshipCount = jobData.relationships_created || 0;

        cisDiscovered.add(ciCount);
        relationshipsCreated.add(relationshipCount);

        // Calculate persistence rate (CIs per second)
        if (duration > 0) {
          const rate = (ciCount / duration) * 1000; // Convert to per second
          ciPersistenceRate.add(rate);
        }

        return { status, ciCount, relationshipCount, duration };
      } else if (status === 'failed' || status === 'error') {
        discoveryJobsFailed.add(1);
        return { status, ciCount: 0, relationshipCount: 0 };
      }
    }

    attempts++;
  }

  return { status, ciCount: 0, relationshipCount: 0 };
}

// Bulk CI ingestion (simulate high-volume discovery)
function bulkIngestCIs(count, token) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  const cis = [];
  for (let i = 0; i < count; i++) {
    cis.push({
      ci_name: `loadtest-ci-${randomString(10)}`,
      ci_type: ['server', 'application', 'database', 'container'][randomIntBetween(0, 3)],
      status: 'active',
      environment: 'test',
      metadata: {
        loadtest: true,
        batch: randomString(8),
      },
    });
  }

  const startTime = Date.now();

  const res = http.post(
    `${BASE_URL}${API_VERSION}/cis/bulk`,
    JSON.stringify({ cis }),
    { headers, tags: { operation: 'bulk_ingest' } }
  );

  const duration = Date.now() - startTime;

  const success = check(res, {
    'bulk ingest successful': (r) => r.status === 201,
    'correct count': (r) => r.json('data.created_count') === count,
  });

  if (success) {
    cisDiscovered.add(count);

    // Calculate ingestion rate
    if (duration > 0) {
      const rate = (count / duration) * 1000;
      ciPersistenceRate.add(rate);
    }

    return res.json('data.created_count');
  }

  return 0;
}

// Sequential Discovery - One job at a time
export function sequentialDiscovery() {
  const token = getAuthToken();

  group('Sequential Discovery', () => {
    const connector = CONNECTORS[randomIntBetween(0, CONNECTORS.length - 1)];

    // Create definition
    const definitionId = createDiscoveryDefinition(connector.id, token);
    if (!definitionId) return;

    // Trigger job
    const job = triggerDiscoveryJob(definitionId, token);
    if (!job) return;

    concurrentJobs.add(1);

    // Wait for completion (with timeout)
    const result = waitForJobCompletion(job.jobId, token, 120000); // 2 minute timeout

    concurrentJobs.add(-1);

    check(result, {
      'job completed successfully': (r) => r.status === 'completed',
      'discovered CIs': (r) => r.ciCount > 0,
    });
  });

  sleep(randomIntBetween(5, 15));
}

// Parallel Discovery - Multiple concurrent jobs
export function parallelDiscovery() {
  const token = getAuthToken();

  group('Parallel Discovery', () => {
    const connector = CONNECTORS[randomIntBetween(0, CONNECTORS.length - 1)];

    // Create definition
    const definitionId = createDiscoveryDefinition(connector.id, token);
    if (!definitionId) return;

    // Trigger job (don't wait for completion)
    const job = triggerDiscoveryJob(definitionId, token);
    if (!job) return;

    concurrentJobs.add(1);

    // Poll a few times but don't block
    for (let i = 0; i < 3; i++) {
      sleep(2);

      const headers = {
        'Authorization': `Bearer ${token}`,
      };

      const res = http.get(
        `${BASE_URL}${API_VERSION}/discovery/jobs/${job.jobId}`,
        { headers }
      );

      if (res.status === 200) {
        const status = res.json('data.status');
        if (status === 'completed' || status === 'failed') {
          concurrentJobs.add(-1);

          if (status === 'completed') {
            const ciCount = res.json('data.cis_discovered') || 0;
            const relationshipCount = res.json('data.relationships_created') || 0;

            cisDiscovered.add(ciCount);
            relationshipsCreated.add(relationshipCount);
            discoveryJobsCompleted.add(1);

            const duration = Date.now() - job.startTime;
            discoveryJobDuration.add(duration);

            if (duration > 0) {
              const rate = (ciCount / duration) * 1000;
              ciPersistenceRate.add(rate);
            }
          } else {
            discoveryJobsFailed.add(1);
          }

          break;
        }
      }
    }
  });

  sleep(randomIntBetween(2, 5));
}

// High-Volume Ingestion - Bulk CI creation
export function highVolumeIngestion() {
  const token = getAuthToken();

  group('High-Volume Ingestion', () => {
    // Ingest batches of CIs
    const batchSizes = [50, 100, 200, 500];
    const batchSize = batchSizes[randomIntBetween(0, batchSizes.length - 1)];

    const created = bulkIngestCIs(batchSize, token);

    check({ created }, {
      'bulk ingest successful': (r) => r.created === batchSize,
      'high throughput': (r) => r.created >= 50,
    });
  });

  sleep(randomIntBetween(1, 3));
}

// Summary handler
export function handleSummary(data) {
  return {
    '/Users/nczitzer/WebstormProjects/happycmdb/infrastructure/testing/load/reports/discovery-summary.html': htmlReport(data),
    '/Users/nczitzer/WebstormProjects/happycmdb/infrastructure/testing/load/reports/discovery-summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data),
  };
}

function htmlReport(data) {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>HappyCMDB Discovery Operations Load Test Results</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }
    h1 { color: #333; border-bottom: 3px solid #28a745; padding-bottom: 10px; }
    h2 { color: #555; margin-top: 30px; }
    .metric { display: inline-block; margin: 10px; padding: 15px; background: #f8f9fa; border-radius: 5px; min-width: 200px; }
    .metric-name { font-weight: bold; color: #666; }
    .metric-value { font-size: 24px; color: #28a745; }
    .pass { color: #28a745; }
    .fail { color: #dc3545; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background-color: #28a745; color: white; }
    tr:hover { background-color: #f1f1f1; }
  </style>
</head>
<body>
  <div class="container">
    <h1>HappyCMDB Discovery Operations Load Test Results</h1>
    <p>Test Duration: ${data.state.testRunDurationMs / 1000}s</p>

    <h2>Discovery Job Metrics</h2>
    <div class="metric">
      <div class="metric-name">Jobs Created</div>
      <div class="metric-value">${data.metrics.discovery_jobs_created?.values.count || '0'}</div>
    </div>
    <div class="metric">
      <div class="metric-name">Jobs Completed</div>
      <div class="metric-value">${data.metrics.discovery_jobs_completed?.values.count || '0'}</div>
    </div>
    <div class="metric">
      <div class="metric-name">Jobs Failed</div>
      <div class="metric-value">${data.metrics.discovery_jobs_failed?.values.count || '0'}</div>
    </div>
    <div class="metric">
      <div class="metric-name">Success Rate</div>
      <div class="metric-value">${
        data.metrics.discovery_jobs_created?.values.count > 0
          ? ((data.metrics.discovery_jobs_completed?.values.count || 0) / data.metrics.discovery_jobs_created.values.count * 100).toFixed(1)
          : '0'
      }%</div>
    </div>

    <h2>CI Discovery Metrics</h2>
    <div class="metric">
      <div class="metric-name">Total CIs Discovered</div>
      <div class="metric-value">${data.metrics.cis_discovered?.values.count || '0'}</div>
    </div>
    <div class="metric">
      <div class="metric-name">Relationships Created</div>
      <div class="metric-value">${data.metrics.relationships_created?.values.count || '0'}</div>
    </div>
    <div class="metric">
      <div class="metric-name">Avg Persistence Rate</div>
      <div class="metric-value">${data.metrics.ci_persistence_rate_per_sec ? data.metrics.ci_persistence_rate_per_sec.values.avg.toFixed(1) : 'N/A'} CIs/sec</div>
    </div>
    <div class="metric">
      <div class="metric-name">Max Concurrent Jobs</div>
      <div class="metric-value">${data.metrics.concurrent_jobs ? data.metrics.concurrent_jobs.values.max : '0'}</div>
    </div>

    <h2>Job Duration Percentiles</h2>
    <table>
      <tr>
        <th>Percentile</th>
        <th>Duration (seconds)</th>
        <th>Threshold</th>
        <th>Status</th>
      </tr>
      <tr>
        <td>50th (Median)</td>
        <td>${data.metrics.discovery_job_duration_ms ? (data.metrics.discovery_job_duration_ms.values['p(50)'] / 1000).toFixed(2) : 'N/A'}</td>
        <td>&lt; 30s</td>
        <td class="${(data.metrics.discovery_job_duration_ms?.values['p(50)'] || 0) < 30000 ? 'pass' : 'fail'}">${(data.metrics.discovery_job_duration_ms?.values['p(50)'] || 0) < 30000 ? 'PASS' : 'FAIL'}</td>
      </tr>
      <tr>
        <td>95th</td>
        <td>${data.metrics.discovery_job_duration_ms ? (data.metrics.discovery_job_duration_ms.values['p(95)'] / 1000).toFixed(2) : 'N/A'}</td>
        <td>&lt; 120s</td>
        <td class="${(data.metrics.discovery_job_duration_ms?.values['p(95)'] || 0) < 120000 ? 'pass' : 'fail'}">${(data.metrics.discovery_job_duration_ms?.values['p(95)'] || 0) < 120000 ? 'PASS' : 'FAIL'}</td>
      </tr>
      <tr>
        <td>99th</td>
        <td>${data.metrics.discovery_job_duration_ms ? (data.metrics.discovery_job_duration_ms.values['p(99)'] / 1000).toFixed(2) : 'N/A'}</td>
        <td>&lt; 300s</td>
        <td class="${(data.metrics.discovery_job_duration_ms?.values['p(99)'] || 0) < 300000 ? 'pass' : 'fail'}">${(data.metrics.discovery_job_duration_ms?.values['p(99)'] || 0) < 300000 ? 'PASS' : 'FAIL'}</td>
      </tr>
    </table>

    <h2>CI Persistence Performance</h2>
    <table>
      <tr>
        <th>Metric</th>
        <th>Value</th>
      </tr>
      <tr>
        <td>Average Rate (CIs/sec)</td>
        <td>${data.metrics.ci_persistence_rate_per_sec ? data.metrics.ci_persistence_rate_per_sec.values.avg.toFixed(2) : 'N/A'}</td>
      </tr>
      <tr>
        <td>Max Rate (CIs/sec)</td>
        <td>${data.metrics.ci_persistence_rate_per_sec ? data.metrics.ci_persistence_rate_per_sec.values.max.toFixed(2) : 'N/A'}</td>
      </tr>
      <tr>
        <td>p95 Rate (CIs/sec)</td>
        <td>${data.metrics.ci_persistence_rate_per_sec ? data.metrics.ci_persistence_rate_per_sec.values['p(95)'].toFixed(2) : 'N/A'}</td>
      </tr>
    </table>

    <p style="margin-top: 30px; color: #666; font-size: 12px;">
      Generated: ${new Date().toISOString()}<br>
      HappyCMDB v2.0 Discovery Load Testing Suite
    </p>
  </div>
</body>
</html>
  `;
}

function textSummary(data) {
  let output = '\n' + '='.repeat(60) + '\n';
  output += 'HappyCMDB Discovery Operations Load Test Summary\n';
  output += '='.repeat(60) + '\n\n';

  output += `Jobs Created: ${data.metrics.discovery_jobs_created?.values.count || '0'}\n`;
  output += `Jobs Completed: ${data.metrics.discovery_jobs_completed?.values.count || '0'}\n`;
  output += `Jobs Failed: ${data.metrics.discovery_jobs_failed?.values.count || '0'}\n`;
  output += `Total CIs Discovered: ${data.metrics.cis_discovered?.values.count || '0'}\n`;
  output += `Relationships Created: ${data.metrics.relationships_created?.values.count || '0'}\n\n`;

  output += 'Job Duration (p95): ' + (data.metrics.discovery_job_duration_ms ? (data.metrics.discovery_job_duration_ms.values['p(95)'] / 1000).toFixed(2) : 'N/A') + 's\n';
  output += 'Avg Persistence Rate: ' + (data.metrics.ci_persistence_rate_per_sec ? data.metrics.ci_persistence_rate_per_sec.values.avg.toFixed(2) : 'N/A') + ' CIs/sec\n';

  return output;
}
