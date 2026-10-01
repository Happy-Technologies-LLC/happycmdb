// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// Neo4j :BusinessService nodes carry no organization; the caller passes the
// set of service ids its organization owns in Postgres (FD-2).
const cypherRuns: Array<Record<string, unknown>> = [];
const neo4jSession = {
  // Plain functions (not jest.fn): jest.config.unit.js resets mock implementations.
  run: async (_query: string, params: Record<string, unknown>) => {
    cypherRuns.push(params);
    return {
      records: [{
        get: (key: string) => ({ ciId: 'ci-1', ciName: 'CI 1', tower: 'compute', costPool: 'hardware', monthlyCost: 42, name: 'Svc' })[key],
      }],
    };
  },
  close: async () => undefined,
};

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => ({ getSession: () => neo4jSession }),
}));

import { PoolAggregationService } from '../pool-aggregation.service';

describe('PoolAggregationService.aggregateBusinessServiceCosts', () => {
  it('aggregateBusinessServiceCosts refuses a service id outside the owned set', async () => {
    const service = PoolAggregationService.getInstance();
    const owned = new Set(['bs-own']);

    await expect(service.aggregateBusinessServiceCosts('bs-foreign', owned)).rejects.toThrow('Business service not found');
    await expect(service.getCostBreakdownByTower('bs-foreign', 'business_service', owned)).rejects.toThrow('Business service not found');
    expect(cypherRuns).toEqual([]);

    const result = await service.aggregateBusinessServiceCosts('bs-own', owned);
    expect(result).toMatchObject({ entityId: 'bs-own', totalMonthlyCost: 42 });
    expect(cypherRuns.every(params => params['serviceId'] === 'bs-own')).toBe(true);
  });
});
