// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// Neo4j :BusinessService nodes carry no organization; the caller passes the
// set of service ids its organization owns in Postgres (FD-2).
const cypherRuns: Array<Record<string, unknown>> = [];
// cap-1 is reached from one CI through each organization's service.
const CAPABILITY_PATHS = [
  { serviceId: 'bs-own', ciId: 'ci-own', monthlyCost: 42 },
  { serviceId: 'bs-foreign', ciId: 'ci-foreign', monthlyCost: 7 },
];
// Every :BusinessService on a counted path must be in the owned set.
const OWNED_PATH_FILTER =
  /WHERE any\(n IN nodes\(path\) WHERE n:BusinessService\)\s+AND all\(n IN nodes\(path\) WHERE NOT n:BusinessService OR n\.id IN \$ownedServiceIds\)/;
const record = (fields: Record<string, unknown>) => ({ get: (key: string) => fields[key] });
const neo4jSession = {
  // Plain functions (not jest.fn): jest.config.unit.js resets mock implementations.
  run: async (query: string, params: Record<string, unknown>) => {
    cypherRuns.push(params);
    if (query.includes('BusinessCapability') && query.includes('ciId')) {
      // Without the owned-path filter, every service under the capability is traversed.
      const allowed = OWNED_PATH_FILTER.test(query) ? (params['ownedServiceIds'] as string[] | undefined) ?? [] : null;
      return {
        records: CAPABILITY_PATHS
          .filter(path => allowed === null || allowed.includes(path.serviceId))
          .map(path => record({ ciId: path.ciId, ciName: path.ciId, tower: 'compute', costPool: 'hardware', monthlyCost: path.monthlyCost })),
      };
    }
    return {
      records: [record({ ciId: 'ci-1', ciName: 'CI 1', tower: 'compute', costPool: 'hardware', monthlyCost: 42, name: 'Svc' })],
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

describe('PoolAggregationService.aggregateBusinessCapabilityCosts', () => {
  it('aggregateBusinessCapabilityCosts only traverses the owned service ids', async () => {
    const service = PoolAggregationService.getInstance();
    const owned = new Set(['bs-own']);

    const result = await service.aggregateBusinessCapabilityCosts('cap-1', owned);
    expect(result).toMatchObject({ entityId: 'cap-1', totalMonthlyCost: 42 });
    expect(result.contributingCIs.map(ci => ci.ciId)).toEqual(['ci-own']);

    await expect(service.getCostBreakdownByTower('cap-1', 'business_capability', owned)).resolves.toEqual({ compute: 42 });
    // No owned set: no service is traversed.
    await expect(service.getCostBreakdownByTower('cap-1', 'business_capability')).resolves.toEqual({});
  });
});
