/**
 * HappyCMDB API Endpoints Load Test
 *
 * Tests all critical REST API endpoints with realistic user workflows
 *
 * Scenarios:
 * - Smoke test: 1 user for 30s
 * - Load test: Ramp to 100 users over 2 minutes
 * - Stress test: Ramp to 500 users over 5 minutes
 * - Spike test: Sudden jump to 1000 users
 * - Endurance test: 100 users for 30 minutes
 *
 * Run: k6 run --out json=reports/api-results.json scripts/api-endpoints.js
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { randomString, randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// Custom metrics
const errorRate = new Rate('errors');
const apiResponseTime = new Trend('api_response_time');
const cisCreated = new Counter('cis_created');
const queriesExecuted = new Counter('queries_executed');

// Configuration
const BASE_URL = __ENV.API_URL || 'http://localhost:3000';
const API_VERSION = '/api/v1';

// Performance thresholds
export const options = {
  scenarios: {
    // Smoke test - Verify basic functionality
    smoke: {
      executor: 'constant-vus',
      vus: 1,
      duration: '30s',
      tags: { test_type: 'smoke' },
      exec: 'smokeTest',
    },

    // Load test - Expected normal load
    load: {
      executor: 'ramping-vus',
      startTime: '35s',
      stages: [
        { duration: '2m', target: 50 },   // Ramp up to 50 users
        { duration: '3m', target: 100 },  // Ramp up to 100 users
        { duration: '2m', target: 100 },  // Stay at 100 users
        { duration: '1m', target: 0 },    // Ramp down
      ],
      tags: { test_type: 'load' },
      exec: 'loadTest',
    },

    // Stress test - Push beyond expected load
    stress: {
      executor: 'ramping-vus',
      startTime: '9m',
      stages: [
        { duration: '2m', target: 200 },  // Ramp to 200
        { duration: '3m', target: 500 },  // Ramp to 500
        { duration: '2m', target: 500 },  // Stay at 500
        { duration: '2m', target: 0 },    // Ramp down
      ],
      tags: { test_type: 'stress' },
      exec: 'stressTest',
    },

    // Spike test - Sudden traffic spike
    spike: {
      executor: 'ramping-vus',
      startTime: '18m',
      stages: [
        { duration: '10s', target: 1000 }, // Sudden spike to 1000
        { duration: '1m', target: 1000 },  // Stay at 1000
        { duration: '10s', target: 0 },    // Quick ramp down
      ],
      tags: { test_type: 'spike' },
      exec: 'spikeTest',
    },
  },

  thresholds: {
    // Overall error rate should be less than 1%
    'errors': ['rate<0.01'],

    // API response times
    'http_req_duration': [
      'p(50)<200',   // 50% of requests should be below 200ms
      'p(95)<500',   // 95% of requests should be below 500ms
      'p(99)<1000',  // 99% of requests should be below 1s
    ],

    // Specific endpoint thresholds
    'http_req_duration{endpoint:get_cis}': ['p(95)<300'],
    'http_req_duration{endpoint:create_ci}': ['p(95)<500'],
    'http_req_duration{endpoint:search_cis}': ['p(95)<600'],
    'http_req_duration{endpoint:get_relationships}': ['p(95)<400'],

    // Request rate (throughput)
    'http_reqs': ['rate>100'], // At least 100 requests per second

    // Success rate
    'http_req_failed': ['rate<0.01'], // Less than 1% failed requests
  },
};

// Test data generators
function generateCI(type = 'server') {
  return {
    ci_name: `test-${type}-${randomString(8)}`,
    ci_type: type,
    status: ['active', 'inactive', 'maintenance'][randomIntBetween(0, 2)],
    environment: ['production', 'staging', 'development'][randomIntBetween(0, 2)],
    metadata: {
      owner: `user-${randomIntBetween(1, 100)}`,
      team: `team-${randomIntBetween(1, 10)}`,
      cost_center: `cc-${randomIntBetween(1000, 9999)}`,
    },
  };
}

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

// Smoke Test - Basic functionality check
export function smokeTest() {
  const token = getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  group('Smoke Test - Health Checks', () => {
    // Health check
    let res = http.get(`${BASE_URL}/health`);
    check(res, {
      'health check is 200': (r) => r.status === 200,
      'health check returns ok': (r) => r.json('status') === 'ok',
    });

    // API version
    res = http.get(`${BASE_URL}${API_VERSION}/version`, { headers });
    check(res, {
      'version endpoint is 200': (r) => r.status === 200,
    });

    // Get CIs (should work even if empty)
    res = http.get(`${BASE_URL}${API_VERSION}/cis`, { headers });
    check(res, {
      'get CIs is 200': (r) => r.status === 200,
      'get CIs returns array': (r) => Array.isArray(r.json('data')),
    });
  });

  sleep(1);
}

// Load Test - Normal expected traffic
export function loadTest() {
  const token = getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  group('Load Test - Typical User Workflow', () => {
    // 1. List CIs
    let res = http.get(`${BASE_URL}${API_VERSION}/cis?limit=50`, {
      headers,
      tags: { endpoint: 'get_cis' },
    });

    const success = check(res, {
      'list CIs is 200': (r) => r.status === 200,
      'response time < 300ms': (r) => r.timings.duration < 300,
    });

    errorRate.add(!success);
    apiResponseTime.add(res.timings.duration);
    queriesExecuted.add(1);

    // 2. Create a CI
    res = http.post(`${BASE_URL}${API_VERSION}/cis`, JSON.stringify(generateCI()), {
      headers,
      tags: { endpoint: 'create_ci' },
    });

    const ciCreated = check(res, {
      'create CI is 201': (r) => r.status === 201,
      'create CI returns ID': (r) => r.json('data.ci_id') !== undefined,
      'response time < 500ms': (r) => r.timings.duration < 500,
    });

    errorRate.add(!ciCreated);
    if (ciCreated) {
      cisCreated.add(1);
      const ciId = res.json('data.ci_id');

      // 3. Get the created CI
      res = http.get(`${BASE_URL}${API_VERSION}/cis/${ciId}`, {
        headers,
        tags: { endpoint: 'get_ci' },
      });

      check(res, {
        'get CI by ID is 200': (r) => r.status === 200,
        'CI data is correct': (r) => r.json('data.ci_id') === ciId,
      });

      // 4. Update the CI
      res = http.patch(`${BASE_URL}${API_VERSION}/cis/${ciId}`, JSON.stringify({
        status: 'active',
        metadata: { updated: true },
      }), {
        headers,
        tags: { endpoint: 'update_ci' },
      });

      check(res, {
        'update CI is 200': (r) => r.status === 200,
      });
    }

    // 5. Search CIs
    res = http.get(`${BASE_URL}${API_VERSION}/cis/search?query=server&limit=20`, {
      headers,
      tags: { endpoint: 'search_cis' },
    });

    check(res, {
      'search CIs is 200': (r) => r.status === 200,
      'search response time < 600ms': (r) => r.timings.duration < 600,
    });

    // 6. Get relationships
    if (ciCreated) {
      const ciId = res.json('data.0.ci_id');
      if (ciId) {
        res = http.get(`${BASE_URL}${API_VERSION}/cis/${ciId}/relationships`, {
          headers,
          tags: { endpoint: 'get_relationships' },
        });

        check(res, {
          'get relationships is 200': (r) => r.status === 200,
          'relationships response time < 400ms': (r) => r.timings.duration < 400,
        });
      }
    }
  });

  // Random sleep between 1-3 seconds to simulate user think time
  sleep(randomIntBetween(1, 3));
}

// Stress Test - Push system limits
export function stressTest() {
  const token = getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  group('Stress Test - High Load Operations', () => {
    // Rapid CI creation
    const ciTypes = ['server', 'application', 'database', 'container', 'service'];
    const ciType = ciTypes[randomIntBetween(0, ciTypes.length - 1)];

    const res = http.post(`${BASE_URL}${API_VERSION}/cis`, JSON.stringify(generateCI(ciType)), {
      headers,
      tags: { endpoint: 'create_ci', test_type: 'stress' },
    });

    const success = check(res, {
      'create CI succeeds under stress': (r) => r.status === 201 || r.status === 429,
      'response time < 1000ms': (r) => r.timings.duration < 1000,
    });

    errorRate.add(!success);

    // Heavy search query
    const searchRes = http.get(`${BASE_URL}${API_VERSION}/cis/search?query=${ciType}&limit=100`, {
      headers,
      tags: { endpoint: 'search_cis', test_type: 'stress' },
    });

    check(searchRes, {
      'search succeeds under stress': (r) => r.status === 200 || r.status === 429,
    });
  });

  sleep(randomIntBetween(0.5, 2));
}

// Spike Test - Handle sudden traffic surge
export function spikeTest() {
  const token = getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  group('Spike Test - Sudden Load', () => {
    // Rapid-fire requests
    const res = http.get(`${BASE_URL}${API_VERSION}/cis?limit=10`, {
      headers,
      tags: { endpoint: 'get_cis', test_type: 'spike' },
    });

    check(res, {
      'system handles spike': (r) => r.status === 200 || r.status === 429 || r.status === 503,
      'no crashes': (r) => r.status !== 500,
    });

    errorRate.add(res.status >= 500);
  });

  // Minimal sleep during spike
  sleep(0.1);
}

// Summary handler
export function handleSummary(data) {
  return {
    '/Users/nczitzer/WebstormProjects/happycmdb/infrastructure/testing/load/reports/api-summary.html': htmlReport(data),
    '/Users/nczitzer/WebstormProjects/happycmdb/infrastructure/testing/load/reports/api-summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}

function htmlReport(data) {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>HappyCMDB API Load Test Results</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }
    h1 { color: #333; border-bottom: 3px solid #007bff; padding-bottom: 10px; }
    h2 { color: #555; margin-top: 30px; }
    .metric { display: inline-block; margin: 10px; padding: 15px; background: #f8f9fa; border-radius: 5px; min-width: 200px; }
    .metric-name { font-weight: bold; color: #666; }
    .metric-value { font-size: 24px; color: #007bff; }
    .pass { color: #28a745; }
    .fail { color: #dc3545; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background-color: #007bff; color: white; }
    tr:hover { background-color: #f1f1f1; }
  </style>
</head>
<body>
  <div class="container">
    <h1>HappyCMDB API Load Test Results</h1>
    <p>Test Duration: ${data.state.testRunDurationMs / 1000}s</p>

    <h2>Key Metrics</h2>
    <div class="metric">
      <div class="metric-name">Total Requests</div>
      <div class="metric-value">${data.metrics.http_reqs ? data.metrics.http_reqs.values.count : 'N/A'}</div>
    </div>
    <div class="metric">
      <div class="metric-name">Request Rate</div>
      <div class="metric-value">${data.metrics.http_reqs ? data.metrics.http_reqs.values.rate.toFixed(2) : 'N/A'}/s</div>
    </div>
    <div class="metric">
      <div class="metric-name">Error Rate</div>
      <div class="metric-value">${data.metrics.errors ? (data.metrics.errors.values.rate * 100).toFixed(2) : '0'}%</div>
    </div>
    <div class="metric">
      <div class="metric-name">CIs Created</div>
      <div class="metric-value">${data.metrics.cis_created ? data.metrics.cis_created.values.count : '0'}</div>
    </div>

    <h2>Response Time Percentiles</h2>
    <table>
      <tr>
        <th>Percentile</th>
        <th>Duration (ms)</th>
        <th>Threshold</th>
        <th>Status</th>
      </tr>
      <tr>
        <td>50th (Median)</td>
        <td>${data.metrics.http_req_duration ? data.metrics.http_req_duration.values['p(50)'].toFixed(2) : 'N/A'}</td>
        <td>&lt; 200ms</td>
        <td class="${(data.metrics.http_req_duration?.values['p(50)'] || 0) < 200 ? 'pass' : 'fail'}">${(data.metrics.http_req_duration?.values['p(50)'] || 0) < 200 ? 'PASS' : 'FAIL'}</td>
      </tr>
      <tr>
        <td>95th</td>
        <td>${data.metrics.http_req_duration ? data.metrics.http_req_duration.values['p(95)'].toFixed(2) : 'N/A'}</td>
        <td>&lt; 500ms</td>
        <td class="${(data.metrics.http_req_duration?.values['p(95)'] || 0) < 500 ? 'pass' : 'fail'}">${(data.metrics.http_req_duration?.values['p(95)'] || 0) < 500 ? 'PASS' : 'FAIL'}</td>
      </tr>
      <tr>
        <td>99th</td>
        <td>${data.metrics.http_req_duration ? data.metrics.http_req_duration.values['p(99)'].toFixed(2) : 'N/A'}</td>
        <td>&lt; 1000ms</td>
        <td class="${(data.metrics.http_req_duration?.values['p(99)'] || 0) < 1000 ? 'pass' : 'fail'}">${(data.metrics.http_req_duration?.values['p(99)'] || 0) < 1000 ? 'PASS' : 'FAIL'}</td>
      </tr>
    </table>

    <h2>Test Scenarios</h2>
    <table>
      <tr>
        <th>Scenario</th>
        <th>VUs</th>
        <th>Duration</th>
        <th>Description</th>
      </tr>
      <tr>
        <td>Smoke</td>
        <td>1</td>
        <td>30s</td>
        <td>Basic functionality verification</td>
      </tr>
      <tr>
        <td>Load</td>
        <td>50-100</td>
        <td>8m</td>
        <td>Expected normal traffic</td>
      </tr>
      <tr>
        <td>Stress</td>
        <td>200-500</td>
        <td>9m</td>
        <td>Beyond expected load</td>
      </tr>
      <tr>
        <td>Spike</td>
        <td>0-1000</td>
        <td>1m20s</td>
        <td>Sudden traffic surge</td>
      </tr>
    </table>

    <p style="margin-top: 30px; color: #666; font-size: 12px;">
      Generated: ${new Date().toISOString()}<br>
      HappyCMDB v2.0 Load Testing Suite
    </p>
  </div>
</body>
</html>
  `;
}

function textSummary(data, opts) {
  const indent = opts.indent || '';
  const colors = opts.enableColors;

  let output = '\n' + indent + '='.repeat(60) + '\n';
  output += indent + 'HappyCMDB API Load Test Summary\n';
  output += indent + '='.repeat(60) + '\n\n';

  output += indent + `Total Requests: ${data.metrics.http_reqs?.values.count || 'N/A'}\n`;
  output += indent + `Request Rate: ${data.metrics.http_reqs?.values.rate.toFixed(2) || 'N/A'}/s\n`;
  output += indent + `Error Rate: ${data.metrics.errors ? (data.metrics.errors.values.rate * 100).toFixed(2) : '0'}%\n`;
  output += indent + `CIs Created: ${data.metrics.cis_created?.values.count || '0'}\n\n`;

  output += indent + 'Response Time Percentiles:\n';
  output += indent + `  p(50): ${data.metrics.http_req_duration?.values['p(50)'].toFixed(2) || 'N/A'}ms\n`;
  output += indent + `  p(95): ${data.metrics.http_req_duration?.values['p(95)'].toFixed(2) || 'N/A'}ms\n`;
  output += indent + `  p(99): ${data.metrics.http_req_duration?.values['p(99)'].toFixed(2) || 'N/A'}ms\n`;

  return output;
}
