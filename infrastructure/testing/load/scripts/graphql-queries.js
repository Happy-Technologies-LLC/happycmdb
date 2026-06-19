/**
 * HappyCMDB GraphQL Load Test
 *
 * Tests GraphQL API performance with complex queries, nested relationships,
 * and query complexity scenarios
 *
 * Run: k6 run --out json=reports/graphql-results.json scripts/graphql-queries.js
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

// Custom metrics
const errorRate = new Rate('graphql_errors');
const queryComplexity = new Trend('query_complexity_score');
const queriesExecuted = new Counter('graphql_queries_executed');
const nestedQueryDepth = new Trend('nested_query_depth');

// Configuration
const BASE_URL = __ENV.API_URL || 'http://localhost:3000';
const GRAPHQL_ENDPOINT = `${BASE_URL}/graphql`;

// Performance thresholds for GraphQL
export const options = {
  scenarios: {
    // Simple queries - Low complexity
    simple_queries: {
      executor: 'constant-vus',
      vus: 50,
      duration: '3m',
      tags: { query_type: 'simple' },
      exec: 'simpleQueries',
    },

    // Complex queries - High complexity, nested relationships
    complex_queries: {
      executor: 'ramping-vus',
      startTime: '3m30s',
      stages: [
        { duration: '1m', target: 30 },
        { duration: '2m', target: 50 },
        { duration: '1m', target: 0 },
      ],
      tags: { query_type: 'complex' },
      exec: 'complexQueries',
    },

    // Mixed workload - Realistic mix of query types
    mixed_workload: {
      executor: 'ramping-vus',
      startTime: '8m',
      stages: [
        { duration: '2m', target: 100 },
        { duration: '3m', target: 100 },
        { duration: '1m', target: 0 },
      ],
      tags: { query_type: 'mixed' },
      exec: 'mixedWorkload',
    },
  },

  thresholds: {
    // Overall error rate
    'graphql_errors': ['rate<0.01'],

    // Response times by query type
    'http_req_duration{query_type:simple}': ['p(95)<300'],
    'http_req_duration{query_type:complex}': ['p(95)<800'],
    'http_req_duration{query_type:mixed}': ['p(95)<500'],

    // Query complexity thresholds
    'query_complexity_score': ['avg<100'], // Average complexity score

    // Overall performance
    'http_req_duration': ['p(95)<500', 'p(99)<1000'],
    'http_req_failed': ['rate<0.01'],
  },
};

// Authentication helper
function getAuthToken() {
  const loginRes = http.post(`${BASE_URL}/api/v1/auth/login`, JSON.stringify({
    username: 'loadtest',
    password: 'loadtest123',
  }), {
    headers: { 'Content-Type': 'application/json' },
  });

  return loginRes.json('token');
}

// GraphQL query helper
function graphqlQuery(query, variables = {}, token, tags = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  const payload = JSON.stringify({ query, variables });

  const res = http.post(GRAPHQL_ENDPOINT, payload, {
    headers,
    tags: { ...tags, operation: 'graphql_query' },
  });

  queriesExecuted.add(1);

  const success = check(res, {
    'status is 200': (r) => r.status === 200,
    'no GraphQL errors': (r) => !r.json('errors'),
    'has data': (r) => r.json('data') !== null,
  });

  errorRate.add(!success);

  return res;
}

// Calculate query complexity score (rough estimate)
function calculateComplexity(query) {
  const fieldCount = (query.match(/\w+\s*{/g) || []).length;
  const nestedLevels = (query.match(/{/g) || []).length;
  const arrayFields = (query.match(/\[\w+\]/g) || []).length;

  return fieldCount * 2 + nestedLevels * 5 + arrayFields * 10;
}

// Simple Queries - Low complexity, fast responses
export function simpleQueries() {
  const token = getAuthToken();

  group('Simple Queries', () => {
    // Query 1: Get CI by ID
    const getCIQuery = `
      query GetCI($id: ID!) {
        ci(id: $id) {
          ci_id
          ci_name
          ci_type
          status
          environment
        }
      }
    `;

    let res = graphqlQuery(getCIQuery, { id: randomIntBetween(1, 1000) }, token, {
      query_name: 'get_ci_by_id',
      query_type: 'simple',
    });

    queryComplexity.add(calculateComplexity(getCIQuery));

    // Query 2: List CIs with pagination
    const listCIsQuery = `
      query ListCIs($limit: Int, $offset: Int) {
        cis(limit: $limit, offset: $offset) {
          ci_id
          ci_name
          ci_type
          status
        }
      }
    `;

    res = graphqlQuery(listCIsQuery, { limit: 20, offset: 0 }, token, {
      query_name: 'list_cis',
      query_type: 'simple',
    });

    queryComplexity.add(calculateComplexity(listCIsQuery));

    // Query 3: Search CIs by type
    const searchByTypeQuery = `
      query SearchByType($ciType: String!) {
        cisByType(type: $ciType) {
          ci_id
          ci_name
          status
          environment
        }
      }
    `;

    const ciTypes = ['server', 'application', 'database', 'container'];
    res = graphqlQuery(
      searchByTypeQuery,
      { ciType: ciTypes[randomIntBetween(0, ciTypes.length - 1)] },
      token,
      { query_name: 'search_by_type', query_type: 'simple' }
    );

    queryComplexity.add(calculateComplexity(searchByTypeQuery));
  });

  sleep(randomIntBetween(1, 3));
}

// Complex Queries - Nested relationships, multiple levels
export function complexQueries() {
  const token = getAuthToken();

  group('Complex Queries', () => {
    // Query 1: Deep nested relationships (3 levels)
    const deepNestedQuery = `
      query DeepRelationships($id: ID!) {
        ci(id: $id) {
          ci_id
          ci_name
          ci_type
          relationships {
            relationship_id
            type
            target {
              ci_id
              ci_name
              ci_type
              relationships {
                relationship_id
                type
                target {
                  ci_id
                  ci_name
                  ci_type
                  metadata
                }
              }
            }
          }
          metadata
          discovery_info {
            last_discovered
            source_connector
            confidence_score
          }
        }
      }
    `;

    let res = graphqlQuery(deepNestedQuery, { id: randomIntBetween(1, 1000) }, token, {
      query_name: 'deep_nested_relationships',
      query_type: 'complex',
    });

    const complexity = calculateComplexity(deepNestedQuery);
    queryComplexity.add(complexity);
    nestedQueryDepth.add(3);

    check(res, {
      'complex query completes in <800ms': (r) => r.timings.duration < 800,
    });

    // Query 2: Multiple relationships with filters
    const multiRelationshipQuery = `
      query MultiRelationships($id: ID!, $relType: String) {
        ci(id: $id) {
          ci_id
          ci_name
          dependsOn: relationships(type: "DEPENDS_ON") {
            relationship_id
            type
            target {
              ci_id
              ci_name
              ci_type
              status
              environment
            }
          }
          hosts: relationships(type: "HOSTS") {
            relationship_id
            target {
              ci_id
              ci_name
              ci_type
            }
          }
          connectsTo: relationships(type: "CONNECTS_TO") {
            relationship_id
            target {
              ci_id
              ci_name
            }
          }
        }
      }
    `;

    res = graphqlQuery(multiRelationshipQuery, { id: randomIntBetween(1, 1000) }, token, {
      query_name: 'multi_relationship_types',
      query_type: 'complex',
    });

    queryComplexity.add(calculateComplexity(multiRelationshipQuery));
    nestedQueryDepth.add(2);

    // Query 3: Aggregation with grouping
    const aggregationQuery = `
      query AggregationStats {
        ciStats {
          totalCount
          byType {
            ci_type
            count
            activeCount
            inactiveCount
          }
          byEnvironment {
            environment
            count
          }
          byStatus {
            status
            count
          }
        }
      }
    `;

    res = graphqlQuery(aggregationQuery, {}, token, {
      query_name: 'aggregation_stats',
      query_type: 'complex',
    });

    queryComplexity.add(calculateComplexity(aggregationQuery));

    // Query 4: Full-text search with nested data
    const fullTextSearchQuery = `
      query FullTextSearch($query: String!, $limit: Int) {
        searchCIs(query: $query, limit: $limit) {
          ci_id
          ci_name
          ci_type
          status
          environment
          metadata
          relationships {
            relationship_id
            type
            target {
              ci_id
              ci_name
            }
          }
          discovery_info {
            source_connector
            last_discovered
            confidence_score
          }
        }
      }
    `;

    const searchTerms = ['server', 'database', 'application', 'prod', 'dev'];
    res = graphqlQuery(
      fullTextSearchQuery,
      {
        query: searchTerms[randomIntBetween(0, searchTerms.length - 1)],
        limit: 50,
      },
      token,
      { query_name: 'fulltext_search', query_type: 'complex' }
    );

    queryComplexity.add(calculateComplexity(fullTextSearchQuery));
  });

  sleep(randomIntBetween(2, 5));
}

// Mixed Workload - Realistic combination of query types
export function mixedWorkload() {
  const token = getAuthToken();

  group('Mixed Workload', () => {
    const queryTypes = [
      // Simple query (70% of traffic)
      () => {
        const query = `
          query QuickLookup($id: ID!) {
            ci(id: $id) {
              ci_id
              ci_name
              ci_type
              status
            }
          }
        `;
        graphqlQuery(query, { id: randomIntBetween(1, 1000) }, token, {
          query_name: 'quick_lookup',
          query_type: 'mixed',
        });
        queryComplexity.add(calculateComplexity(query));
      },

      // Medium complexity (20% of traffic)
      () => {
        const query = `
          query MediumComplexity($type: String!) {
            cisByType(type: $type) {
              ci_id
              ci_name
              status
              environment
              relationships {
                relationship_id
                type
                target {
                  ci_id
                  ci_name
                }
              }
            }
          }
        `;
        const types = ['server', 'application', 'database'];
        graphqlQuery(query, { type: types[randomIntBetween(0, types.length - 1)] }, token, {
          query_name: 'medium_complexity',
          query_type: 'mixed',
        });
        queryComplexity.add(calculateComplexity(query));
        nestedQueryDepth.add(2);
      },

      // Complex query (10% of traffic)
      () => {
        const query = `
          query HighComplexity($id: ID!) {
            ci(id: $id) {
              ci_id
              ci_name
              ci_type
              metadata
              relationships {
                relationship_id
                type
                target {
                  ci_id
                  ci_name
                  relationships {
                    relationship_id
                    target {
                      ci_id
                      ci_name
                    }
                  }
                }
              }
            }
          }
        `;
        graphqlQuery(query, { id: randomIntBetween(1, 1000) }, token, {
          query_name: 'high_complexity',
          query_type: 'mixed',
        });
        queryComplexity.add(calculateComplexity(query));
        nestedQueryDepth.add(3);
      },
    ];

    // Select query type based on realistic distribution
    const rand = Math.random();
    if (rand < 0.7) {
      queryTypes[0](); // Simple (70%)
    } else if (rand < 0.9) {
      queryTypes[1](); // Medium (20%)
    } else {
      queryTypes[2](); // Complex (10%)
    }
  });

  sleep(randomIntBetween(1, 4));
}

// Summary handler
export function handleSummary(data) {
  return {
    '/Users/nczitzer/WebstormProjects/happycmdb/infrastructure/testing/load/reports/graphql-summary.html': htmlReport(data),
    '/Users/nczitzer/WebstormProjects/happycmdb/infrastructure/testing/load/reports/graphql-summary.json': JSON.stringify(data, null, 2),
    stdout: textSummary(data),
  };
}

function htmlReport(data) {
  return `
<!DOCTYPE html>
<html>
<head>
  <title>HappyCMDB GraphQL Load Test Results</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px; }
    h1 { color: #333; border-bottom: 3px solid #6f42c1; padding-bottom: 10px; }
    h2 { color: #555; margin-top: 30px; }
    .metric { display: inline-block; margin: 10px; padding: 15px; background: #f8f9fa; border-radius: 5px; min-width: 200px; }
    .metric-name { font-weight: bold; color: #666; }
    .metric-value { font-size: 24px; color: #6f42c1; }
    .pass { color: #28a745; }
    .fail { color: #dc3545; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background-color: #6f42c1; color: white; }
    tr:hover { background-color: #f1f1f1; }
  </style>
</head>
<body>
  <div class="container">
    <h1>HappyCMDB GraphQL Load Test Results</h1>
    <p>Test Duration: ${data.state.testRunDurationMs / 1000}s</p>

    <h2>Key Metrics</h2>
    <div class="metric">
      <div class="metric-name">GraphQL Queries</div>
      <div class="metric-value">${data.metrics.graphql_queries_executed?.values.count || '0'}</div>
    </div>
    <div class="metric">
      <div class="metric-name">Avg Query Complexity</div>
      <div class="metric-value">${data.metrics.query_complexity_score ? data.metrics.query_complexity_score.values.avg.toFixed(1) : 'N/A'}</div>
    </div>
    <div class="metric">
      <div class="metric-name">Avg Nested Depth</div>
      <div class="metric-value">${data.metrics.nested_query_depth ? data.metrics.nested_query_depth.values.avg.toFixed(1) : 'N/A'}</div>
    </div>
    <div class="metric">
      <div class="metric-name">Error Rate</div>
      <div class="metric-value">${data.metrics.graphql_errors ? (data.metrics.graphql_errors.values.rate * 100).toFixed(2) : '0'}%</div>
    </div>

    <h2>Response Time by Query Type</h2>
    <table>
      <tr>
        <th>Query Type</th>
        <th>p50 (ms)</th>
        <th>p95 (ms)</th>
        <th>p99 (ms)</th>
        <th>Threshold</th>
        <th>Status</th>
      </tr>
      <tr>
        <td>Simple Queries</td>
        <td>${data.metrics['http_req_duration{query_type:simple}'] ? data.metrics['http_req_duration{query_type:simple}'].values['p(50)'].toFixed(2) : 'N/A'}</td>
        <td>${data.metrics['http_req_duration{query_type:simple}'] ? data.metrics['http_req_duration{query_type:simple}'].values['p(95)'].toFixed(2) : 'N/A'}</td>
        <td>${data.metrics['http_req_duration{query_type:simple}'] ? data.metrics['http_req_duration{query_type:simple}'].values['p(99)'].toFixed(2) : 'N/A'}</td>
        <td>&lt; 300ms (p95)</td>
        <td class="${(data.metrics['http_req_duration{query_type:simple}']?.values['p(95)'] || 0) < 300 ? 'pass' : 'fail'}">${(data.metrics['http_req_duration{query_type:simple}']?.values['p(95)'] || 0) < 300 ? 'PASS' : 'FAIL'}</td>
      </tr>
      <tr>
        <td>Complex Queries</td>
        <td>${data.metrics['http_req_duration{query_type:complex}'] ? data.metrics['http_req_duration{query_type:complex}'].values['p(50)'].toFixed(2) : 'N/A'}</td>
        <td>${data.metrics['http_req_duration{query_type:complex}'] ? data.metrics['http_req_duration{query_type:complex}'].values['p(95)'].toFixed(2) : 'N/A'}</td>
        <td>${data.metrics['http_req_duration{query_type:complex}'] ? data.metrics['http_req_duration{query_type:complex}'].values['p(99)'].toFixed(2) : 'N/A'}</td>
        <td>&lt; 800ms (p95)</td>
        <td class="${(data.metrics['http_req_duration{query_type:complex}']?.values['p(95)'] || 0) < 800 ? 'pass' : 'fail'}">${(data.metrics['http_req_duration{query_type:complex}']?.values['p(95)'] || 0) < 800 ? 'PASS' : 'FAIL'}</td>
      </tr>
      <tr>
        <td>Mixed Workload</td>
        <td>${data.metrics['http_req_duration{query_type:mixed}'] ? data.metrics['http_req_duration{query_type:mixed}'].values['p(50)'].toFixed(2) : 'N/A'}</td>
        <td>${data.metrics['http_req_duration{query_type:mixed}'] ? data.metrics['http_req_duration{query_type:mixed}'].values['p(95)'].toFixed(2) : 'N/A'}</td>
        <td>${data.metrics['http_req_duration{query_type:mixed}'] ? data.metrics['http_req_duration{query_type:mixed}'].values['p(99)'].toFixed(2) : 'N/A'}</td>
        <td>&lt; 500ms (p95)</td>
        <td class="${(data.metrics['http_req_duration{query_type:mixed}']?.values['p(95)'] || 0) < 500 ? 'pass' : 'fail'}">${(data.metrics['http_req_duration{query_type:mixed}']?.values['p(95)'] || 0) < 500 ? 'PASS' : 'FAIL'}</td>
      </tr>
    </table>

    <h2>Query Complexity Analysis</h2>
    <table>
      <tr>
        <th>Metric</th>
        <th>Min</th>
        <th>Avg</th>
        <th>Max</th>
      </tr>
      <tr>
        <td>Complexity Score</td>
        <td>${data.metrics.query_complexity_score ? data.metrics.query_complexity_score.values.min.toFixed(1) : 'N/A'}</td>
        <td>${data.metrics.query_complexity_score ? data.metrics.query_complexity_score.values.avg.toFixed(1) : 'N/A'}</td>
        <td>${data.metrics.query_complexity_score ? data.metrics.query_complexity_score.values.max.toFixed(1) : 'N/A'}</td>
      </tr>
      <tr>
        <td>Nested Depth</td>
        <td>${data.metrics.nested_query_depth ? data.metrics.nested_query_depth.values.min.toFixed(0) : 'N/A'}</td>
        <td>${data.metrics.nested_query_depth ? data.metrics.nested_query_depth.values.avg.toFixed(1) : 'N/A'}</td>
        <td>${data.metrics.nested_query_depth ? data.metrics.nested_query_depth.values.max.toFixed(0) : 'N/A'}</td>
      </tr>
    </table>

    <p style="margin-top: 30px; color: #666; font-size: 12px;">
      Generated: ${new Date().toISOString()}<br>
      HappyCMDB v2.0 GraphQL Load Testing Suite
    </p>
  </div>
</body>
</html>
  `;
}

function textSummary(data) {
  let output = '\n' + '='.repeat(60) + '\n';
  output += 'HappyCMDB GraphQL Load Test Summary\n';
  output += '='.repeat(60) + '\n\n';

  output += `Total Queries: ${data.metrics.graphql_queries_executed?.values.count || '0'}\n`;
  output += `Avg Complexity: ${data.metrics.query_complexity_score ? data.metrics.query_complexity_score.values.avg.toFixed(1) : 'N/A'}\n`;
  output += `Avg Nested Depth: ${data.metrics.nested_query_depth ? data.metrics.nested_query_depth.values.avg.toFixed(1) : 'N/A'}\n`;
  output += `Error Rate: ${data.metrics.graphql_errors ? (data.metrics.graphql_errors.values.rate * 100).toFixed(2) : '0'}%\n\n`;

  output += 'Response Times (p95):\n';
  output += `  Simple: ${data.metrics['http_req_duration{query_type:simple}']?.values['p(95)'].toFixed(2) || 'N/A'}ms\n`;
  output += `  Complex: ${data.metrics['http_req_duration{query_type:complex}']?.values['p(95)'].toFixed(2) || 'N/A'}ms\n`;
  output += `  Mixed: ${data.metrics['http_req_duration{query_type:mixed}']?.values['p(95)'].toFixed(2) || 'N/A'}ms\n`;

  return output;
}
