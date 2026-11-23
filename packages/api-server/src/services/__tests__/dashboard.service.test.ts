// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard integrity (HAP-1929): no number leaves DashboardService unless it is
 * computed from the caller organization's graph data. A field with no backing
 * data is null (or an empty list) and is named in the payload's `unavailable`.
 *
 * Neo4j is a fake session over an in-memory list of :CI property bags that
 * answers the statements the service issues.
 */

import neo4j from 'neo4j-driver';

type Props = Record<string, unknown>;
const ORG = '11111111-1111-4111-8111-111111111111';
let CIS: Props[] = [];

const int = (n: number) => neo4j.int(n);
const row = (fields: Record<string, unknown>) => ({ get: (key: string) => fields[key] });
const cost = (ci: Props) => (typeof ci['tbm_monthly_cost'] === 'number' ? ci['tbm_monthly_cost'] : null);

function run(rawQuery: string): Array<ReturnType<typeof row>> {
  const query = rawQuery.replace(/\s+/g, ' ').trim();
  const active = CIS.filter(ci => ci['status'] === 'active' && ci['organization_id'] === ORG);
  if (query.includes('RETURN capability, sum(monthlyCost) AS totalCost, count(monthlyCost) AS costedCIs')) {
    const groups = new Map<string, { sum: number; costed: number }>();
    for (const ci of active) {
      const tower = (ci['tbm_resource_tower'] || 'Uncategorized') as string;
      const group = groups.get(tower) ?? { sum: 0, costed: 0 };
      const c = cost(ci);
      if (c !== null) { group.sum += c; group.costed++; }
      groups.set(tower, group);
    }
    return [...groups].map(([capability, g]) => row({ capability, totalCost: int(g.sum), costedCIs: int(g.costed) }));
  }
  if (query.includes('RETURN count(ci) AS totalCIs')) return [row({ totalCIs: int(active.length) })];
  if (query.includes('AS tier_1,')) {
    return [row(Object.fromEntries(['tier_1', 'tier_2', 'tier_3', 'tier_4'].map(tier =>
      [tier, int(active.filter(ci => ci['bsm_business_criticality'] === tier).length)])))];
  }
  if (query.includes('AS criticality')) {
    return active.filter(ci => ['tier_1', 'tier_2'].includes(ci['bsm_business_criticality'] as string))
      .map(ci => row({ id: ci['id'], name: ci['name'], type: ci['type'], criticality: ci['bsm_business_criticality'] }));
  }
  if (query.includes('ci.tbm_monthly_cost > 0')) {
    return active.filter(ci => (cost(ci) ?? 0) > 0)
      .sort((a, b) => cost(b)! - cost(a)!)
      .map(ci => row({ id: ci['id'], name: ci['name'], monthlyCost: int(cost(ci)!) }));
  }
  if (query.includes('ci.bsm_customer_facing = true')) {
    return active.filter(ci => ci['bsm_customer_facing'] === true).map(ci => row({
      id: ci['id'], name: ci['name'], monthlyCost: cost(ci) === null ? null : int(cost(ci)!),
    }));
  }
  if (query.includes('WITH ci.status AS status, count(ci) AS count')) {
    const owned = CIS.filter(ci => ci['organization_id'] === ORG);
    const statuses = [...new Set(owned.map(ci => ci['status'] as string))];
    return statuses.map(status => row({
      status, count: int(owned.filter(ci => ci['status'] === status).length),
      sampleCIs: owned.filter(ci => ci['status'] === status).map(properties => ({ properties })),
    }));
  }
  if (query.includes('AS cloudCost')) {
    const costed = active.filter(ci => cost(ci) !== null);
    const sum = (rows: Props[]) => rows.reduce((total, ci) => total + cost(ci)!, 0);
    const cloud = costed.filter(ci => ci['discovery_provider'] === 'aws');
    return [row({
      totalCost: int(sum(costed)), costedCIs: int(costed.length),
      cloudCost: int(sum(cloud)), cloudCostedCIs: int(cloud.length),
    })];
  }
  throw new Error(`fake Neo4j: unmodelled statement: ${query}`);
}

let mockPgQuery: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> = async () => ({ rows: [] });

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ query: (sql: string, params?: unknown[]) => mockPgQuery(sql, params) }),
  getNeo4jClient: () => ({
    getSession: () => ({ run: async (query: string) => ({ records: run(query) }), close: async () => undefined }),
  }),
  CITraversalLimitError: class extends Error {},
  MAX_CI_TRAVERSAL_NODES: 100,
  MAX_CI_TRAVERSAL_WORK: 400,
}));

import { DashboardService } from '../dashboard.service';

/** Every number in a payload, by path. Anything numeric must be explainable. */
function numericLeaves(value: unknown, path = ''): Record<string, number> {
  if (typeof value === 'number') return { [path]: value };
  if (Array.isArray(value)) return Object.assign({}, ...value.map((v, i) => numericLeaves(v, `${path}[${i}]`)));
  if (value && typeof value === 'object') {
    return Object.assign({}, ...Object.entries(value).map(([k, v]) => numericLeaves(v, path ? `${path}.${k}` : k)));
  }
  return {};
}

const service = new DashboardService();
const range = () => service.parseTimeRange(90);

async function allPayloads() {
  return {
    executive: await service.getExecutiveSummary(ORG, range()),
    cio: await service.getCIOMetrics(ORG, range()),
    finops: await service.getFinOpsDashboard(ORG, range()),
    businessService: await service.getBusinessServiceDashboard(ORG),
  };
}

// The only numbers a graph with no cost or revenue data may produce: CI counts.
const COUNTS_ONLY = {
  'serviceHealthByTier[0].serviceCount': 0, 'serviceHealthByTier[1].serviceCount': 0,
  'serviceHealthByTier[2].serviceCount': 0, 'serviceHealthByTier[3].serviceCount': 0,
};

describe('DashboardService carries no fabricated numbers', () => {
  it('an organization with no CIs gets no number except zero counts, and names what is unavailable', async () => {
    CIS = [{ id: 'other-org', status: 'active', organization_id: 'someone-else', tbm_monthly_cost: 999 }];
    const { executive, cio, finops, businessService } = await allPayloads();

    expect(numericLeaves(executive)).toEqual(COUNTS_ONLY);
    expect(numericLeaves(cio)).toEqual({ 'configurationAccuracy.totalCIs': 0 });
    expect(numericLeaves(finops)).toEqual({});
    expect(numericLeaves(businessService)).toEqual({});

    expect(executive.totalITSpend).toBeNull();
    expect(executive.unavailable).toEqual(expect.arrayContaining(['totalITSpend', 'costTrends']));
    expect(finops.onPremVsCloud).toEqual({ onPremCost: null, cloudCost: null, totalCost: null, tcoComparison: [] });
    expect(finops.unavailable).toEqual(expect.arrayContaining(['onPremVsCloud.totalCost', 'cloudCosts']));
    expect(businessService!.serviceHealth).toEqual([]);
    expect(businessService!.revenueAtRisk).toEqual({
      totalAnnualRevenue: null, revenueAtRisk: null, percentageAtRisk: null, affectedIncidents: [],
    });
    expect(businessService!.complianceStatus.pciCompliant).toBeNull();
    expect(businessService!.unavailable).toEqual(expect.arrayContaining(['serviceHealth', 'revenueAtRisk']));
  });

  it('CIs without cost or revenue properties yield null cost, never a zero', async () => {
    CIS = [
      { id: 'a', name: 'a', type: 'server', status: 'active', organization_id: ORG, bsm_customer_facing: true,
        bsm_business_criticality: 'tier_1', tbm_resource_tower: 'compute' },
      { id: 'b', name: 'b', type: 'server', status: 'active', organization_id: ORG, bsm_customer_facing: true },
    ];
    const { executive, cio, finops } = await allPayloads();

    expect(numericLeaves(executive)).toEqual({ ...COUNTS_ONLY, 'serviceHealthByTier[0].serviceCount': 1 });
    expect(numericLeaves(cio)).toEqual({ 'configurationAccuracy.totalCIs': 2 });
    expect(numericLeaves(finops)).toEqual({});
    expect(executive.costByCapability.map(c => c.totalCost)).toEqual([null, null]);
    expect(executive.topCostDrivers).toEqual([]);
    expect(executive.valueScorecard).toEqual([
      { serviceId: 'a', serviceName: 'a', annualRevenue: null, monthlyCost: null, roi: null, customers: null },
      { serviceId: 'b', serviceName: 'b', annualRevenue: null, monthlyCost: null, roi: null, customers: null },
    ]);
    expect(executive.unavailable).toEqual(expect.arrayContaining([
      'totalITSpend', 'costByCapability.totalCost', 'valueScorecard.monthlyCost',
      'valueScorecard.annualRevenue', 'valueScorecard.roi', 'valueScorecard.customers',
    ]));
    expect(cio.costByCapability.map(c => c.cost)).toEqual([null, null]);
    expect(finops.costByTower.map(t => t.cost)).toEqual([null, null]);
  });

  it('real costs are summed; change, revenue and budget stay null', async () => {
    CIS = [
      { id: 'a', name: 'a', type: 'server', status: 'active', organization_id: ORG, tbm_monthly_cost: 300,
        tbm_resource_tower: 'compute', discovery_provider: 'aws', bsm_customer_facing: true },
      { id: 'b', name: 'b', type: 'server', status: 'active', organization_id: ORG, tbm_monthly_cost: 100,
        tbm_resource_tower: 'storage' },
      { id: 'c', name: 'c', type: 'server', status: 'retired', organization_id: ORG, tbm_monthly_cost: 5000 },
    ];
    const { executive, finops, cio } = await allPayloads();

    expect(executive.totalITSpend).toBe(400);
    expect(executive.topCostDrivers).toEqual([
      { serviceId: 'a', serviceName: 'a', monthlyCost: 300, trend: null, changePercent: null },
      { serviceId: 'b', serviceName: 'b', monthlyCost: 100, trend: null, changePercent: null },
    ]);
    expect(executive.valueScorecard).toEqual([
      { serviceId: 'a', serviceName: 'a', annualRevenue: null, monthlyCost: 300, roi: null, customers: null },
    ]);
    expect(executive.unavailable).not.toContain('totalITSpend');
    expect(finops.onPremVsCloud).toEqual({ onPremCost: 100, cloudCost: 300, totalCost: 400, tcoComparison: [] });
    expect(finops.budgetVariance).toEqual([
      { capability: 'compute', budgetAllocated: null, actualSpend: 300, variance: null, variancePercent: null },
      { capability: 'storage', budgetAllocated: null, actualSpend: 100, variance: null, variancePercent: null },
    ]);
    expect(cio.costByCapability).toEqual([
      { capability: 'compute', cost: 300, budgetAllocated: null, variance: null },
      { capability: 'storage', cost: 100, budgetAllocated: null, variance: null },
    ]);
  });

  it('returns identical payloads for the same graph on repeated calls', async () => {
    CIS = [
      { id: 'a', name: 'a', type: 'server', status: 'active', organization_id: ORG, tbm_monthly_cost: 300,
        tbm_resource_tower: 'compute', bsm_business_criticality: 'tier_1', bsm_customer_facing: true },
    ];
    const first = await allPayloads();
    const second = await allPayloads();
    expect(second).toEqual(first);
  });

  it('reports a segment with no costed CI as null, not 0', async () => {
    CIS = [
      { id: 'a', name: 'a', type: 'server', status: 'active', organization_id: ORG, tbm_monthly_cost: 500 },
      { id: 'b', name: 'b', type: 'server', status: 'active', organization_id: ORG, discovery_provider: 'aws' },
    ];
    const { finops } = await allPayloads();
    expect(finops.onPremVsCloud).toEqual({ onPremCost: 500, cloudCost: null, totalCost: 500, tcoComparison: [] });
    expect(finops.unavailable).toContain('onPremVsCloud.cloudCost');
    expect(finops.unavailable).not.toContain('onPremVsCloud.onPremCost');
  });
});

describe('ITSM dashboard when the ITIL records cannot be read', () => {
  const pgError = (code: string) => Object.assign(new Error('postgres failure'), { code });
  const isCatalogCheck = (sql: string) => sql.includes('pg_attribute');

  it('a schema without ITIL tables yields null counts and empty lists, all named; the graph KPI still computes', async () => {
    CIS = [
      { id: 'a', name: 'a', type: 'server', status: 'active', organization_id: ORG },
      { id: 'b', name: 'b', type: 'server', status: 'retired', organization_id: ORG },
    ];
    const statements: string[] = [];
    mockPgQuery = async (sql) => {
      statements.push(sql);
      if (isCatalogCheck(sql)) return { rows: [{ available: false }] };
      throw new Error('record tables must not be queried when the catalog says they are absent');
    };
    const itsm = await service.getITSMDashboard(ORG);

    expect(statements).toHaveLength(1);
    expect(itsm.openIncidents).toEqual([]);
    expect(itsm.changesInProgress).toEqual([]);
    expect(itsm.topFailingCIs).toEqual([]);
    expect(itsm.openIncidentCount).toBeNull();
    expect(itsm.changesInProgressCount).toBeNull();
    expect(itsm.unavailable).toEqual(expect.arrayContaining([
      'openIncidents', 'openIncidentCount', 'changesInProgress', 'changesInProgressCount',
      'topFailingCIs', 'slaCompliance', 'baselineCompliance',
    ]));
    expect(itsm.ciStatus.map(group => [group.status, group.count]).sort()).toEqual([['active', 1], ['retired', 1]]);
    expect(numericLeaves({ ...itsm, ciStatus: [] })).toEqual({});
  });

  it.each([
    ['column drift in a record query (42703)', '42703', false],
    ['a statement timeout (57014)', '57014', false],
    ['a failing catalog check', '57014', true],
  ])('%s is an error, not an "ITIL unavailable" dashboard', async (_name, code, failCatalog) => {
    CIS = [];
    mockPgQuery = async (sql) => {
      if (isCatalogCheck(sql) && !failCatalog) return { rows: [{ available: true }] };
      throw pgError(code);
    };
    await expect(service.getITSMDashboard(ORG)).rejects.toMatchObject({ code });
  });
});
