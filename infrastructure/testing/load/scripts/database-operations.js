/**
 * HappyCMDB Database Performance Load Test
 *
 * Tests database query performance, cache hit rates, and resource utilization
 *
 * Tests:
 * - Neo4j graph queries (simple, complex, pathfinding)
 * - PostgreSQL queries (dimensional queries, aggregations)
 * - Redis cache performance (hit rate, eviction)
 *
 * Run: k6 run --out json=reports/database-results.json scripts/database-operations.js
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend, Counter, Gauge } from 'k6/metrics';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// Custom metrics
const neo4jQueryDuration = new Trend('neo4j_query_duration_ms');
const postgresQueryDuration = new Trend('postgres_query_duration_ms');
const redisQueryDuration = new Trend('redis_query_duration_ms');

const cacheHits = new Counter('cache_hits');
const cacheMisses = new Counter('cache_misses');
const cacheHitRate = new Rate('cache_hit_rate');

const graphTraversalDepth = new Trend('graph_traversal_depth');
const graphNodesReturned = new Trend('graph_nodes_returned');
const graphRelationshipsReturned = new Trend('graph_relationships_returned');

const postgresRowsReturned = new Trend('postgres_rows_returned');
const postgresAggregations = new Counter('postgres_aggregations');

const databaseErrors = new Rate('database_errors');

// Configuration
const BASE_URL = __ENV.API_URL || 'http://localhost:3000';
const API_VERSION = '/api/v1';

// Performance thresholds
export const options = {
  scenarios: {
    // Neo4j simple queries
    neo4j_simple: {
      executor: 'constant-vus',
      vus: 30,
      duration: '3m',
      tags: { db_type: 'neo4j', query_type: 'simple' },
      exec: 'neo4jSimpleQueries',
    },

    // Neo4j complex graph queries
    neo4j_complex: {
      executor: 'ramping-vus',
      startTime: '3m30s',
      stages: [
        { duration: '1m', target: 20 },
        { duration: '2m', target: 40 },
        { duration: '1m', target: 0 },
      ],
      tags: { db_type: 'neo4j', query_type: 'complex' },
      exec: 'neo4jComplexQueries',
    },

    // PostgreSQL analytical queries
    postgres_analytics: {
      executor: 'ramping-vus',
      startTime: '8m',
      stages: [
        { duration: '1m', target: 30 },
        { duration: '2m', target: 50 },
        { duration: '1m', target: 0 },
      ],
      tags: { db_type: 'postgres', query_type: 'analytics' },
      exec: 'postgresAnalytics',
    },

    // Redis cache operations
    redis_cache: {
      executor: 'constant-vus',
      vus: 100,
      duration: '5m',
      tags: { db_type: 'redis' },
      exec: 'redisCacheOps',
    },
  },

  thresholds: {
    // Neo4j performance
    'neo4j_query_duration_ms{query_type:simple}': ['p(95)<100'],
    'neo4j_query_duration_ms{query_type:complex}': ['p(95)<500'],
    'neo4j_query_duration_ms{query_type:pathfinding}': ['p(95)<800'],

    // PostgreSQL performance
    'postgres_query_duration_ms': ['p(95)<300'],

    // Redis performance
    'redis_query_duration_ms': ['p(95)<10'],

    // Cache hit rate > 70%
    'cache_hit_rate': ['rate>0.7'],

    // Error rate < 1%
    'database_errors': ['rate<0.01'],

    // Overall performance
    'http_req_duration': ['p(95)<1000'],
    'http_req_failed': ['rate<0.01'],
  },
};

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

// Neo4j Simple Queries - Basic CRUD and lookups
export function neo4jSimpleQueries() {
  const token = getAuthToken();
  const headers = {
    'Authorization': `Bearer ${token}`,
  };

  group('Neo4j Simple Queries', () => {
    // Query 1: Get CI by ID (indexed lookup)
    const ciId = randomIntBetween(1, 10000);
    let startTime = Date.now();

    let res = http.get(`${BASE_URL}${API_VERSION}/cis/${ciId}`, {
      headers,
      tags: { db_operation: 'neo4j_get_by_id', query_type: 'simple' },
    });

    let duration = Date.now() - startTime;
    neo4jQueryDuration.add(duration, { query_type: 'simple' });

    const success = check(res, {
      'get by ID is 200 or 404': (r) => r.status === 200 || r.status === 404,
      'response time < 100ms': (r) => duration < 100,
    });

    databaseErrors.add(!success);

    if (res.status === 200) {
      graphNodesReturned.add(1);
    }

    // Query 2: List CIs by type (label scan)
    const ciTypes = ['server', 'application', 'database', 'container', 'service'];
    const ciType = ciTypes[randomIntBetween(0, ciTypes.length - 1)];

    startTime = Date.now();

    res = http.get(`${BASE_URL}${API_VERSION}/cis?type=${ciType}&limit=50`, {
      headers,
      tags: { db_operation: 'neo4j_list_by_type', query_type: 'simple' },
    });

    duration = Date.now() - startTime;
    neo4jQueryDuration.add(duration, { query_type: 'simple' });

    check(res, {
      'list by type is 200': (r) => r.status === 200,
      'returns array': (r) => Array.isArray(r.json('data')),
    });

    if (res.status === 200) {
      const count = res.json('data').length;
      graphNodesReturned.add(count);
    }

    // Query 3: Get direct relationships (1-hop)
    startTime = Date.now();

    res = http.get(`${BASE_URL}${API_VERSION}/cis/${ciId}/relationships`, {
      headers,
      tags: { db_operation: 'neo4j_relationships', query_type: 'simple' },
    });

    duration = Date.now() - startTime;
    neo4jQueryDuration.add(duration, { query_type: 'simple' });

    check(res, {
      'get relationships is 200 or 404': (r) => r.status === 200 || r.status === 404,
    });

    if (res.status === 200) {
      const rels = res.json('data') || [];
      graphRelationshipsReturned.add(rels.length);
      graphTraversalDepth.add(1);
    }
  });

  sleep(randomIntBetween(1, 3));
}

// Neo4j Complex Queries - Graph traversals, pathfinding
export function neo4jComplexQueries() {
  const token = getAuthToken();
  const headers = {
    'Authorization': `Bearer ${token}`,
  };

  group('Neo4j Complex Queries', () => {
    const ciId = randomIntBetween(1, 10000);

    // Query 1: Multi-hop relationship traversal (3 levels deep)
    let startTime = Date.now();

    let res = http.get(`${BASE_URL}${API_VERSION}/cis/${ciId}/relationships?depth=3`, {
      headers,
      tags: { db_operation: 'neo4j_deep_traversal', query_type: 'complex' },
    });

    let duration = Date.now() - startTime;
    neo4jQueryDuration.add(duration, { query_type: 'complex' });

    const success = check(res, {
      'deep traversal completes': (r) => r.status === 200 || r.status === 404,
      'response time < 500ms': (r) => duration < 500,
    });

    databaseErrors.add(!success);

    if (res.status === 200) {
      graphTraversalDepth.add(3);
      const data = res.json('data') || [];
      graphNodesReturned.add(data.length);
    }

    // Query 2: Shortest path between CIs
    const targetId = randomIntBetween(1, 10000);

    startTime = Date.now();

    res = http.get(`${BASE_URL}${API_VERSION}/cis/${ciId}/path-to/${targetId}`, {
      headers,
      tags: { db_operation: 'neo4j_shortest_path', query_type: 'pathfinding' },
    });

    duration = Date.now() - startTime;
    neo4jQueryDuration.add(duration, { query_type: 'pathfinding' });

    check(res, {
      'pathfinding completes': (r) => r.status === 200 || r.status === 404,
      'response time < 800ms': (r) => duration < 800,
    });

    // Query 3: Dependency impact analysis (reverse relationships)
    startTime = Date.now();

    res = http.get(`${BASE_URL}${API_VERSION}/cis/${ciId}/impact-analysis`, {
      headers,
      tags: { db_operation: 'neo4j_impact_analysis', query_type: 'complex' },
    });

    duration = Date.now() - startTime;
    neo4jQueryDuration.add(duration, { query_type: 'complex' });

    check(res, {
      'impact analysis completes': (r) => r.status === 200 || r.status === 404,
    });

    // Query 4: Pattern matching (find specific graph patterns)
    startTime = Date.now();

    res = http.get(`${BASE_URL}${API_VERSION}/cis/patterns?pattern=app-depends-on-db`, {
      headers,
      tags: { db_operation: 'neo4j_pattern_match', query_type: 'complex' },
    });

    duration = Date.now() - startTime;
    neo4jQueryDuration.add(duration, { query_type: 'complex' });

    check(res, {
      'pattern matching completes': (r) => r.status === 200,
    });
  });

  sleep(randomIntBetween(2, 5));
}

// PostgreSQL Analytics - Dimensional queries, aggregations
export function postgresAnalytics() {
  const token = getAuthToken();
  const headers = {
    'Authorization': `Bearer ${token}`,
  };

  group('PostgreSQL Analytics', () => {
    // Query 1: Time-series data (CI counts over time)
    let startTime = Date.now();

    let res = http.get(`${BASE_URL}${API_VERSION}/analytics/ci-counts?period=7d&interval=1h`, {
      headers,
      tags: { db_operation: 'postgres_timeseries', query_type: 'analytics' },
    });

    let duration = Date.now() - startTime;
    postgresQueryDuration.add(duration);

    const success = check(res, {
      'timeseries query is 200': (r) => r.status === 200,
      'response time < 300ms': (r) => duration < 300,
    });

    databaseErrors.add(!success);

    if (res.status === 200) {
      const data = res.json('data') || [];
      postgresRowsReturned.add(data.length);
      postgresAggregations.add(1);
    }

    // Query 2: Dimensional aggregation (group by type, environment)
    startTime = Date.now();

    res = http.get(`${BASE_URL}${API_VERSION}/analytics/ci-breakdown?dimensions=type,environment,status`, {
      headers,
      tags: { db_operation: 'postgres_dimensional', query_type: 'analytics' },
    });

    duration = Date.now() - startTime;
    postgresQueryDuration.add(duration);

    check(res, {
      'dimensional query is 200': (r) => r.status === 200,
    });

    if (res.status === 200) {
      const data = res.json('data') || [];
      postgresRowsReturned.add(data.length);
      postgresAggregations.add(1);
    }

    // Query 3: Discovery job history (time-series with joins)
    startTime = Date.now();

    res = http.get(`${BASE_URL}${API_VERSION}/analytics/discovery-history?period=30d`, {
      headers,
      tags: { db_operation: 'postgres_history', query_type: 'analytics' },
    });

    duration = Date.now() - startTime;
    postgresQueryDuration.add(duration);

    check(res, {
      'history query is 200': (r) => r.status === 200,
    });

    // Query 4: Aggregated metrics (complex aggregation)
    startTime = Date.now();

    res = http.get(`${BASE_URL}${API_VERSION}/analytics/metrics-summary`, {
      headers,
      tags: { db_operation: 'postgres_aggregation', query_type: 'analytics' },
    });

    duration = Date.now() - startTime;
    postgresQueryDuration.add(duration);

    check(res, {
      'metrics summary is 200': (r) => r.status === 200,
    });

    if (res.status === 200) {
      postgresAggregations.add(1);
    }
  });

  sleep(randomIntBetween(1, 4));
}

// Redis Cache Operations - Cache hit/miss testing
export function redisCacheOps() {
  const token = getAuthToken();
  const headers = {
    'Authorization': `Bearer ${token}`,
  };

  group('Redis Cache Operations', () => {
    // Mix of cache hits (frequently accessed CIs) and misses (random CIs)
    const useFrequentId = Math.random() < 0.7; // 70% cache hits
    const ciId = useFrequentId
      ? randomIntBetween(1, 100)      // Hot data (likely cached)
      : randomIntBetween(1000, 10000); // Cold data (likely not cached)

    const startTime = Date.now();

    const res = http.get(`${BASE_URL}${API_VERSION}/cis/${ciId}`, {
      headers,
      tags: { db_operation: 'redis_cache_lookup' },
    });

    const duration = Date.now() - startTime;
    redisQueryDuration.add(duration);

    // Infer cache hit/miss based on response time
    // Cached responses should be < 10ms, DB queries > 20ms
    const wasCacheHit = duration < 15;

    if (wasCacheHit) {
      cacheHits.add(1);
      cacheHitRate.add(1);
    } else {
      cacheMisses.add(1);
      cacheHitRate.add(0);
    }

    check(res, {
      'cache lookup successful': (r) => r.status === 200 || r.status === 404,
      'fast response (likely cached)': (r) => duration < 50,
    });

    // Also test cache writes (CI creation)
    if (Math.random() < 0.1) { // 10% of iterations
      const createRes = http.post(`${BASE_URL}${API_VERSION}/cis`, JSON.stringify({
        ci_name: `cache-test-${randomIntBetween(1, 100000)}`,
        ci_type: 'server',
        status: 'active',
        environment: 'test',
      }), {
        headers: { ...headers, 'Content-Type': 'application/json' },
        tags: { db_operation: 'redis_cache_write' },
      });

      check(createRes, {
        'cache write successful': (r) => r.status === 201,
      });
    }
  });

  sleep(randomIntBetween(0.1, 1));
}

// Summary handler
export function handleSummary(data) {
  return {
    '/Users/nczitzer/WebstormProjects/happycmdb/infrastructure/testing/load/reports/database-summary.html': htmlReport(data),
    '/Users/nczitzer/WebstormProjects/happycmdb/infrastructure/testing/load/reports/database-summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data),
  };
}

function htmlReport(data) {
  const cacheHitRateValue = data.metrics.cache_hit_rate
    ? (data.metrics.cache_hit_rate.values.rate * 100).toFixed(1)
    : '0';

  return `
<!DOCTYPE html>
<html>
<head>
  <title>HappyCMDB Database Performance Test Results</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }
    h1 { color: #333; border-bottom: 3px solid #17a2b8; padding-bottom: 10px; }
    h2 { color: #555; margin-top: 30px; }
    .metric { display: inline-block; margin: 10px; padding: 15px; background: #f8f9fa; border-radius: 5px; min-width: 200px; }
    .metric-name { font-weight: bold; color: #666; }
    .metric-value { font-size: 24px; color: #17a2b8; }
    .pass { color: #28a745; }
    .fail { color: #dc3545; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background-color: #17a2b8; color: white; }
    tr:hover { background-color: #f1f1f1; }
  </style>
</head>
<body>
  <div class="container">
    <h1>HappyCMDB Database Performance Test Results</h1>
    <p>Test Duration: ${data.state.testRunDurationMs / 1000}s</p>

    <h2>Cache Performance</h2>
    <div class="metric">
      <div class="metric-name">Cache Hits</div>
      <div class="metric-value">${data.metrics.cache_hits?.values.count || '0'}</div>
    </div>
    <div class="metric">
      <div class="metric-name">Cache Misses</div>
      <div class="metric-value">${data.metrics.cache_misses?.values.count || '0'}</div>
    </div>
    <div class="metric">
      <div class="metric-name">Cache Hit Rate</div>
      <div class="metric-value">${cacheHitRateValue}%</div>
    </div>
    <div class="metric">
      <div class="metric-name">Avg Redis Response</div>
      <div class="metric-value">${data.metrics.redis_query_duration_ms ? data.metrics.redis_query_duration_ms.values.avg.toFixed(2) : 'N/A'}ms</div>
    </div>

    <h2>Neo4j Query Performance</h2>
    <table>
      <tr>
        <th>Query Type</th>
        <th>p50 (ms)</th>
        <th>p95 (ms)</th>
        <th>p99 (ms)</th>
        <th>Threshold (p95)</th>
        <th>Status</th>
      </tr>
      <tr>
        <td>Simple Queries</td>
        <td>${data.metrics['neo4j_query_duration_ms{query_type:simple}'] ? data.metrics['neo4j_query_duration_ms{query_type:simple}'].values['p(50)'].toFixed(2) : 'N/A'}</td>
        <td>${data.metrics['neo4j_query_duration_ms{query_type:simple}'] ? data.metrics['neo4j_query_duration_ms{query_type:simple}'].values['p(95)'].toFixed(2) : 'N/A'}</td>
        <td>${data.metrics['neo4j_query_duration_ms{query_type:simple}'] ? data.metrics['neo4j_query_duration_ms{query_type:simple}'].values['p(99)'].toFixed(2) : 'N/A'}</td>
        <td>&lt; 100ms</td>
        <td class="${(data.metrics['neo4j_query_duration_ms{query_type:simple}']?.values['p(95)'] || 0) < 100 ? 'pass' : 'fail'}">${(data.metrics['neo4j_query_duration_ms{query_type:simple}']?.values['p(95)'] || 0) < 100 ? 'PASS' : 'FAIL'}</td>
      </tr>
      <tr>
        <td>Complex Queries</td>
        <td>${data.metrics['neo4j_query_duration_ms{query_type:complex}'] ? data.metrics['neo4j_query_duration_ms{query_type:complex}'].values['p(50)'].toFixed(2) : 'N/A'}</td>
        <td>${data.metrics['neo4j_query_duration_ms{query_type:complex}'] ? data.metrics['neo4j_query_duration_ms{query_type:complex}'].values['p(95)'].toFixed(2) : 'N/A'}</td>
        <td>${data.metrics['neo4j_query_duration_ms{query_type:complex}'] ? data.metrics['neo4j_query_duration_ms{query_type:complex}'].values['p(99)'].toFixed(2) : 'N/A'}</td>
        <td>&lt; 500ms</td>
        <td class="${(data.metrics['neo4j_query_duration_ms{query_type:complex}']?.values['p(95)'] || 0) < 500 ? 'pass' : 'fail'}">${(data.metrics['neo4j_query_duration_ms{query_type:complex}']?.values['p(95)'] || 0) < 500 ? 'PASS' : 'FAIL'}</td>
      </tr>
      <tr>
        <td>Pathfinding</td>
        <td>${data.metrics['neo4j_query_duration_ms{query_type:pathfinding}'] ? data.metrics['neo4j_query_duration_ms{query_type:pathfinding}'].values['p(50)'].toFixed(2) : 'N/A'}</td>
        <td>${data.metrics['neo4j_query_duration_ms{query_type:pathfinding}'] ? data.metrics['neo4j_query_duration_ms{query_type:pathfinding}'].values['p(95)'].toFixed(2) : 'N/A'}</td>
        <td>${data.metrics['neo4j_query_duration_ms{query_type:pathfinding}'] ? data.metrics['neo4j_query_duration_ms{query_type:pathfinding}'].values['p(99)'].toFixed(2) : 'N/A'}</td>
        <td>&lt; 800ms</td>
        <td class="${(data.metrics['neo4j_query_duration_ms{query_type:pathfinding}']?.values['p(95)'] || 0) < 800 ? 'pass' : 'fail'}">${(data.metrics['neo4j_query_duration_ms{query_type:pathfinding}']?.values['p(95)'] || 0) < 800 ? 'PASS' : 'FAIL'}</td>
      </tr>
    </table>

    <h2>PostgreSQL Query Performance</h2>
    <table>
      <tr>
        <th>Metric</th>
        <th>p50 (ms)</th>
        <th>p95 (ms)</th>
        <th>p99 (ms)</th>
        <th>Threshold</th>
        <th>Status</th>
      </tr>
      <tr>
        <td>Analytics Queries</td>
        <td>${data.metrics.postgres_query_duration_ms ? data.metrics.postgres_query_duration_ms.values['p(50)'].toFixed(2) : 'N/A'}</td>
        <td>${data.metrics.postgres_query_duration_ms ? data.metrics.postgres_query_duration_ms.values['p(95)'].toFixed(2) : 'N/A'}</td>
        <td>${data.metrics.postgres_query_duration_ms ? data.metrics.postgres_query_duration_ms.values['p(99)'].toFixed(2) : 'N/A'}</td>
        <td>&lt; 300ms (p95)</td>
        <td class="${(data.metrics.postgres_query_duration_ms?.values['p(95)'] || 0) < 300 ? 'pass' : 'fail'}">${(data.metrics.postgres_query_duration_ms?.values['p(95)'] || 0) < 300 ? 'PASS' : 'FAIL'}</td>
      </tr>
    </table>

    <h2>Graph Query Statistics</h2>
    <table>
      <tr>
        <th>Metric</th>
        <th>Avg</th>
        <th>Max</th>
      </tr>
      <tr>
        <td>Traversal Depth</td>
        <td>${data.metrics.graph_traversal_depth ? data.metrics.graph_traversal_depth.values.avg.toFixed(1) : 'N/A'}</td>
        <td>${data.metrics.graph_traversal_depth ? data.metrics.graph_traversal_depth.values.max : 'N/A'}</td>
      </tr>
      <tr>
        <td>Nodes Returned</td>
        <td>${data.metrics.graph_nodes_returned ? data.metrics.graph_nodes_returned.values.avg.toFixed(1) : 'N/A'}</td>
        <td>${data.metrics.graph_nodes_returned ? data.metrics.graph_nodes_returned.values.max : 'N/A'}</td>
      </tr>
      <tr>
        <td>Relationships Returned</td>
        <td>${data.metrics.graph_relationships_returned ? data.metrics.graph_relationships_returned.values.avg.toFixed(1) : 'N/A'}</td>
        <td>${data.metrics.graph_relationships_returned ? data.metrics.graph_relationships_returned.values.max : 'N/A'}</td>
      </tr>
    </table>

    <p style="margin-top: 30px; color: #666; font-size: 12px;">
      Generated: ${new Date().toISOString()}<br>
      HappyCMDB v2.0 Database Performance Testing Suite
    </p>
  </div>
</body>
</html>
  `;
}

function textSummary(data) {
  let output = '\n' + '='.repeat(60) + '\n';
  output += 'HappyCMDB Database Performance Test Summary\n';
  output += '='.repeat(60) + '\n\n';

  const cacheHitRate = data.metrics.cache_hit_rate
    ? (data.metrics.cache_hit_rate.values.rate * 100).toFixed(1)
    : '0';

  output += `Cache Hit Rate: ${cacheHitRate}%\n`;
  output += `Cache Hits: ${data.metrics.cache_hits?.values.count || '0'}\n`;
  output += `Cache Misses: ${data.metrics.cache_misses?.values.count || '0'}\n\n`;

  output += 'Neo4j Query Performance (p95):\n';
  output += `  Simple: ${data.metrics['neo4j_query_duration_ms{query_type:simple}']?.values['p(95)'].toFixed(2) || 'N/A'}ms\n`;
  output += `  Complex: ${data.metrics['neo4j_query_duration_ms{query_type:complex}']?.values['p(95)'].toFixed(2) || 'N/A'}ms\n`;
  output += `  Pathfinding: ${data.metrics['neo4j_query_duration_ms{query_type:pathfinding}']?.values['p(95)'].toFixed(2) || 'N/A'}ms\n\n`;

  output += 'PostgreSQL Query Performance (p95):\n';
  output += `  Analytics: ${data.metrics.postgres_query_duration_ms?.values['p(95)'].toFixed(2) || 'N/A'}ms\n`;

  return output;
}
