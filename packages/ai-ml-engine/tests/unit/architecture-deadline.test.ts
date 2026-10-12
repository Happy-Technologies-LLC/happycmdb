// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

const clientQuery = jest.fn(async (sql: string) => {
  if (sql.includes('SELECT DISTINCT s.name')) return { rows: [{ name: 'Empty service', ci_id: null }] };
  return { rows: [] };
});
const release = jest.fn();
const getClient = jest.fn(async () => ({ query: clientQuery, release }));
const run = jest.fn(async (_cypher: string, _params?: unknown, _options?: { timeout: number }) => ({ records: [] }));

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ getClient, query: jest.fn(async () => ({ rows: [] })) }),
  getNeo4jClient: () => ({ getSession: () => ({ run, close: async () => undefined }) }),
}));

import {
  ArchitectureOptimizationEngine, withArchitectureDeadline, architectureFailure,
} from '../../src/engines/architecture-optimization-engine';

beforeEach(() => {
  Object.assign(ArchitectureOptimizationEngine, { instance: undefined });
  clientQuery.mockClear();
  clientQuery.mockImplementation(async (sql) => {
    if (sql.includes('SELECT DISTINCT s.name')) return { rows: [{ name: 'Empty service', ci_id: null }] };
    return { rows: [] };
  });
  run.mockImplementation(async () => ({ records: [] }));
  getClient.mockImplementation(async () => ({ query: clientQuery, release }));
  release.mockClear();
  run.mockClear();
});

it('bounds service mapping and persistence with SET LOCAL statement_timeout in their SQL transactions', async () => {
  const engine = ArchitectureOptimizationEngine.getInstance();
  const result = await withArchitectureDeadline(Date.now() + 20_000, async () => {
    const service = await engine.analyzeBusinessService('service-1', 'org-a');
    await engine.analyzeArchitecture([], 'org-a');
    return service;
  });
  expect(result?.business_service_name).toBe('Empty service');
  const statements = clientQuery.mock.calls.map(([sql]) => sql);
  expect(statements.filter((sql) => sql === 'BEGIN')).toHaveLength(2);
  expect(statements.filter((sql) => sql.includes("set_config('statement_timeout'"))).toHaveLength(2);
  expect(statements.some((sql) => sql.includes('SELECT DISTINCT s.name'))).toBe(true);
  expect(statements.some((sql) => sql.includes('INSERT INTO architecture_analyses'))).toBe(true);
  expect(statements.filter((sql) => sql === 'COMMIT')).toHaveLength(2);
  expect(release).toHaveBeenCalledTimes(2);
  for (const [, values] of clientQuery.mock.calls.filter(([sql]) => sql.includes("set_config('statement_timeout'"))) {
    const milliseconds = Number(String(values?.[0]).replace('ms', ''));
    expect(milliseconds).toBeGreaterThan(0);
    expect(milliseconds).toBeLessThanOrEqual(5000);
  }
});

it('propagates the remaining request budget to the owned-root Neo4j statement', async () => {
  clientQuery.mockImplementation(async (sql) => {
    if (sql.includes('SELECT DISTINCT s.name')) return { rows: [{ name: 'Service', ci_id: 'ci-1' }] };
    return { rows: [] };
  });
  const engine = ArchitectureOptimizationEngine.getInstance();
  await withArchitectureDeadline(Date.now() + 1000, () => engine.analyzeBusinessService('service-1', 'org-a'));
  expect(run).toHaveBeenCalledTimes(1);
  const options = run.mock.calls[0][2];
  expect(options?.timeout).toBeGreaterThan(0);
  expect(options?.timeout).toBeLessThanOrEqual(1000);
});

it('maps a PostgreSQL statement cancellation to fixed 504', () => {
  expect(architectureFailure(Object.assign(new Error('SQL details'), { code: '57014' })))
    .toEqual({ status: 504, message: 'Architecture analysis timed out' });
  expect(architectureFailure(Object.assign(new Error('SQL details'), { code: '53200' })))
    .toEqual({ status: 503, message: 'Architecture analysis resource limit exceeded' });
});
