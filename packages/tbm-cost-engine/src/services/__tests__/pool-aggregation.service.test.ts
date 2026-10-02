// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// The caller passes its token organization and the set of service ids it owns
// in Postgres (FD-2); each :BusinessService node must also carry that
// organization_id (FD-16 c).
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const cypherRuns: Array<Record<string, unknown>> = [];
// :BusinessService nodes; bs-foreign-node is owned by org A in Postgres but the node is org B's.
const SERVICE_NODES: Record<string, { name: string; organizationId?: string; ciId: string; monthlyCost: number }> = {
  'bs-own': { name: 'Own Service', organizationId: ORG_A, ciId: 'ci-own', monthlyCost: 42 },
  'bs-foreign': { name: 'Foreign Service', organizationId: ORG_B, ciId: 'ci-foreign', monthlyCost: 7 },
  'bs-foreign-node': { name: 'B Node', organizationId: ORG_B, ciId: 'ci-foreign-node', monthlyCost: 900 },
  'bs-orphan': { name: 'Orphan Node', ciId: 'ci-orphan', monthlyCost: 300 },
};
// cap-1 is reached from one CI through each service.
const CAPABILITY_SERVICES = ['bs-own', 'bs-foreign', 'bs-foreign-node', 'bs-orphan'];
// Every :BusinessService on a counted path must be in the owned set, and carry the caller's org.
const OWNED_PATH_FILTER =
  /WHERE any\(n IN nodes\(path\) WHERE n:BusinessService\)\s+AND all\(n IN nodes\(path\) WHERE NOT n:BusinessService OR n\.id IN \$ownedServiceIds\)/;
const NODE_ORG_PATH_FILTER = /AND all\(n IN nodes\(path\) WHERE NOT n:BusinessService OR n\.organization_id = \$organizationId\)/;
const NODE_ORG_FILTER = /MATCH \(bs:BusinessService \{id: \$serviceId\}\)\s+WHERE bs\.organization_id = \$organizationId\s/;
const record = (fields: Record<string, unknown>) => ({ get: (key: string) => fields[key] });
const ciRecord = (serviceId: string) => {
  const node = SERVICE_NODES[serviceId]!;
  return record({ ciId: node.ciId, ciName: node.ciId, tower: 'compute', costPool: 'hardware', monthlyCost: node.monthlyCost });
};
const neo4jSession = {
  // Plain functions (not jest.fn): jest.config.unit.js resets mock implementations.
  run: async (query: string, params: Record<string, unknown>) => {
    cypherRuns.push(params);
    if (query.includes('BusinessCapability') && query.includes('ciId')) {
      // Without a filter, every service under the capability is traversed, as Neo4j would.
      const owned = OWNED_PATH_FILTER.test(query) ? (params['ownedServiceIds'] as string[] | undefined) ?? [] : null;
      const orgOnly = NODE_ORG_PATH_FILTER.test(query);
      return {
        records: CAPABILITY_SERVICES
          .filter(id => owned === null || owned.includes(id))
          .filter(id => !orgOnly || SERVICE_NODES[id]!.organizationId === params['organizationId'])
          .map(ciRecord),
      };
    }
    if (query.includes('BusinessCapability')) {
      return { records: [record({ name: 'Capability' })] };
    }
    // Business service statements: without the node-org predicate, the node matches whoever owns it.
    const serviceId = params['serviceId'] as string;
    const node = SERVICE_NODES[serviceId];
    if (node === undefined || (NODE_ORG_FILTER.test(query) && node.organizationId !== params['organizationId'])) {
      return { records: [] };
    }
    return { records: query.includes('ciId') ? [ciRecord(serviceId)] : [record({ name: node.name })] };
  },
  close: async () => undefined,
};

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => ({ getSession: () => neo4jSession }),
}));

import { PoolAggregationService } from '../pool-aggregation.service';

beforeEach(() => {
  cypherRuns.length = 0;
});

describe('PoolAggregationService.aggregateBusinessServiceCosts', () => {
  it('aggregateBusinessServiceCosts refuses a service id outside the owned set', async () => {
    const service = PoolAggregationService.getInstance();
    const scope = { organizationId: ORG_A, ownedServiceIds: new Set(['bs-own']) };

    await expect(service.aggregateBusinessServiceCosts('bs-foreign', scope)).rejects.toThrow('Business service not found');
    await expect(service.getCostBreakdownByTower('bs-foreign', 'business_service', scope)).rejects.toThrow('Business service not found');
    expect(cypherRuns).toEqual([]);

    const result = await service.aggregateBusinessServiceCosts('bs-own', scope);
    expect(result).toMatchObject({ entityId: 'bs-own', entityName: 'Own Service', totalMonthlyCost: 42 });
    expect(cypherRuns.every(params => params['serviceId'] === 'bs-own')).toBe(true);
  });

  it('aggregateBusinessServiceCosts ignores a node whose organization_id differs', async () => {
    const service = PoolAggregationService.getInstance();
    // Org A owns both ids in Postgres; bs-foreign-node's node is org B's, bs-orphan's has no org.
    const scope = { organizationId: ORG_A, ownedServiceIds: new Set(['bs-own', 'bs-foreign-node', 'bs-orphan']) };

    for (const id of ['bs-foreign-node', 'bs-orphan']) {
      await expect(service.aggregateBusinessServiceCosts(id, scope)).rejects.toThrow('Business service not found');
      await expect(service.getTopCostContributors(id, 'business_service', 10, scope)).rejects.toThrow('Business service not found');
    }
    expect(cypherRuns.length).toBeGreaterThan(0);
    expect(cypherRuns.every(params => params['organizationId'] === ORG_A)).toBe(true);
  });
});

describe('PoolAggregationService.aggregateBusinessCapabilityCosts', () => {
  it('aggregateBusinessCapabilityCosts only traverses the owned service ids', async () => {
    const service = PoolAggregationService.getInstance();
    const scope = { organizationId: ORG_A, ownedServiceIds: new Set(['bs-own']) };

    const result = await service.aggregateBusinessCapabilityCosts('cap-1', scope);
    expect(result).toMatchObject({ entityId: 'cap-1', totalMonthlyCost: 42 });
    expect(result.contributingCIs.map(ci => ci.ciId)).toEqual(['ci-own']);

    await expect(service.getCostBreakdownByTower('cap-1', 'business_capability', scope)).resolves.toEqual({ compute: 42 });
    // No scope: no service is traversed.
    await expect(service.getCostBreakdownByTower('cap-1', 'business_capability')).resolves.toEqual({});
  });

  it('aggregateBusinessCapabilityCosts ignores service nodes of other organizations', async () => {
    const service = PoolAggregationService.getInstance();
    const scope = { organizationId: ORG_A, ownedServiceIds: new Set(['bs-own', 'bs-foreign-node', 'bs-orphan']) };

    const result = await service.aggregateBusinessCapabilityCosts('cap-1', scope);
    expect(result.contributingCIs.map(ci => ci.ciId)).toEqual(['ci-own']);
    expect(result.totalMonthlyCost).toBe(42);
  });
});
