// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant scoping for the TBM GraphQL resolvers (FD-2: Postgres
 * dim_business_services.organization_id is the tenant authority for Neo4j
 * :BusinessService ids; FD-3 b: global aggregates are admin-only).
 *
 * Postgres answers the ownership query from an in-memory table; Neo4j is a
 * recording session over a graph in which every :BusinessService node is
 * reachable by id, whoever owns it.
 */

import { GraphQLError } from 'graphql';
import type { TokenPayload } from '../../../auth/types';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

// dim_business_services (service_id -> organization_id).
const SERVICE_ORG: Record<string, string> = {
  'bs-a-app': ORG_A,
  'bs-a-db': ORG_A,
  'bs-b-app': ORG_B,
};

// Plain functions (not jest.fn): jest.config.unit.js resets mock implementations.
const pgCalls: Array<{ sql: string; params: unknown[] }> = [];
const pgQuery = async (sql: string, params: unknown[] = []) => {
  pgCalls.push({ sql, params });
  if (!sql.includes('dim_business_services')) return { rows: [] };
  const [organizationId, serviceId] = params as string[];
  const rows = Object.entries(SERVICE_ORG)
    .filter(([id, org]) => org === organizationId && (serviceId === undefined || id === serviceId))
    .map(([id]) => ({ service_id: id }));
  return { rows };
};

jest.mock('@cmdb/database', () => ({
  getPostgresClient: () => ({ query: pgQuery, pool: { query: pgQuery } }),
}));

import { tbmResolvers } from '../tbm.resolvers';
import type { GraphQLContext } from '../index';

type Params = Record<string, unknown>;
const cypherRuns: Array<{ query: string; params: Params }> = [];
const record = (fields: Record<string, unknown>) => ({ get: (key: string) => fields[key] });
const GRAPH_SERVICES: Record<string, { name: string; cost: number; tower: string }> = {
  'bs-a-app': { name: 'A App', cost: 100, tower: 'compute' },
  'bs-b-app': { name: 'B Secret App', cost: 7, tower: 'data' },
};
// cap-1 is realized by both organizations' services.
const CAPABILITY_SERVICES = ['bs-a-app', 'bs-b-app'];
// The tenancy filter must bind to the REALIZES optional match itself.
const REALIZES_OWNED_FILTER =
  /OPTIONAL MATCH \(cap\)-\[:REALIZES\]->\(service:BusinessService\)\s+WHERE service\.id IN \$orgServiceIds\s/;
const int = (n: number) => ({ toNumber: () => n });
const neo4jSession = {
  run: async (query: string, params: Params = {}) => {
    cypherRuns.push({ query, params });
    if (query.includes('BusinessService {id: $serviceId}')) {
      const service = GRAPH_SERVICES[params['serviceId'] as string];
      if (service === undefined) return { records: [] };
      return {
        records: [record({
          serviceId: params['serviceId'], serviceName: service.name, userCount: 0,
          totalCost: service.cost, ciCount: { toNumber: () => 1 }, towers: [],
        })],
      };
    }
    if (query.includes('BusinessCapability')) {
      // Without the filter on the REALIZES match, every realizing service is traversed.
      const allowed = REALIZES_OWNED_FILTER.test(query) ? (params['orgServiceIds'] as string[] | undefined) ?? [] : null;
      const services = CAPABILITY_SERVICES.filter(id => allowed === null || allowed.includes(id));
      if (query.includes('capabilityName')) {
        return {
          records: [record({
            capabilityId: params['capabilityId'], capabilityName: 'Cap', serviceIds: services,
            totalCost: services.reduce((sum, id) => sum + GRAPH_SERVICES[id]!.cost, 0), ciCount: int(services.length),
          })],
        };
      }
      // Cost-by-tower query.
      return {
        records: services.map(id => record({ tower: GRAPH_SERVICES[id]!.tower, totalCost: GRAPH_SERVICES[id]!.cost, ciCount: int(1) })),
      };
    }
    return { records: [] };
  },
  close: async () => undefined,
};

let neo4jSessionsOpened = 0;

function contextAs(role: TokenPayload['_role'], organizationId?: string): GraphQLContext {
  return {
    _neo4jClient: {
      getSession: () => {
        neo4jSessionsOpened += 1;
        return neo4jSession;
      },
    } as unknown as GraphQLContext['_neo4jClient'],
    _loaders: {} as GraphQLContext['_loaders'],
    user: { _userId: 'u-1', _username: 'tester', _role: role, _type: 'access', _organizationId: organizationId },
  };
}

async function graphQLErrorOf(promise: Promise<unknown>): Promise<GraphQLError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(GraphQLError);
  return error as GraphQLError;
}

const { Query, Mutation } = tbmResolvers;

beforeEach(() => {
  pgCalls.length = 0;
  cypherRuns.length = 0;
  neo4jSessionsOpened = 0;
});

describe('costsByBusinessService', () => {
  it('costsByBusinessService throws FORBIDDEN without an org claim', async () => {
    for (const context of [contextAs('admin'), contextAs('admin', 'not-a-uuid')]) {
      const error = await graphQLErrorOf(Query.costsByBusinessService(null, { id: 'bs-a-app' }, context));
      expect(error.extensions['code']).toBe('FORBIDDEN');
    }
    expect(pgCalls).toEqual([]);
    expect(cypherRuns).toEqual([]);
  });

  it('costsByBusinessService errors for a foreign service', async () => {
    const asA = contextAs('viewer', ORG_A);
    const foreign = await graphQLErrorOf(Query.costsByBusinessService(null, { id: 'bs-b-app' }, asA));
    const missing = await graphQLErrorOf(Query.costsByBusinessService(null, { id: 'bs-missing' }, asA));

    expect(foreign.extensions['code']).toBe('NOT_FOUND');
    expect([foreign.message, foreign.extensions]).toEqual([missing.message, missing.extensions]);
    expect(cypherRuns).toEqual([]);
    expect(pgCalls.map(call => call.params)).toEqual([[ORG_A, 'bs-b-app'], [ORG_A, 'bs-missing']]);

    const own = await Query.costsByBusinessService(null, { id: 'bs-a-app' }, asA);
    expect(own).toMatchObject({ serviceId: 'bs-a-app', totalMonthlyCost: 100 });
  });
});

describe('costsByCapability', () => {
  it('costsByCapability throws FORBIDDEN without an org claim', async () => {
    for (const context of [contextAs('admin'), contextAs('admin', 'not-a-uuid')]) {
      const error = await graphQLErrorOf(Query.costsByCapability(null, { id: 'cap-1' }, context));
      expect(error.extensions['code']).toBe('FORBIDDEN');
    }
    expect(pgCalls).toEqual([]);
    expect(neo4jSessionsOpened).toBe(0);
    expect(cypherRuns).toEqual([]);
  });

  it('costsByCapability passes only owned ids', async () => {
    const result = await Query.costsByCapability(null, { id: 'cap-1' }, contextAs('viewer', ORG_A));

    // Only bs-a-app realizes cap-1 for org A; org B's service is not traversed by either query.
    expect(result).toMatchObject({
      totalMonthlyCost: 100,
      supportingServices: 1,
      costByTower: [{ tower: 'compute', totalCost: 100, ciCount: 1 }],
    });

    expect(pgCalls.map(call => call.params)).toEqual([[ORG_A]]);
    expect(cypherRuns.length).toBeGreaterThan(0);
    for (const run of cypherRuns) {
      expect([...(run.params['orgServiceIds'] as string[])].sort()).toEqual(['bs-a-app', 'bs-a-db']);
    }
  });
});

describe('global TBM resolvers (FD-3 b)', () => {
  const GLOBAL: Array<[string, (context: GraphQLContext) => Promise<unknown>]> = [
    ['costSummary', c => Query.costSummary(null, {}, c)],
    ['costsByTower', c => Query.costsByTower(null, {}, c)],
    ['costTrends', c => Query.costTrends(null, {}, c)],
    ['costAllocations', c => Query.costAllocations(null, { ciId: 'ci-1' }, c)],
    ['licenses', c => Query.licenses(null, {}, c)],
    ['upcomingRenewals', c => Query.upcomingRenewals(null, {}, c)],
    ['allocateCosts', c => Mutation.allocateCosts(null, {
      input: { sourceId: 'ci-1', targetType: 'BUSINESS_SERVICE', targetIds: ['bs-a-app'] },
    }, c)],
    ['importGLData', c => Mutation.importGLData(null, {}, c)],
  ];

  it.each(GLOBAL)('%s: global resolvers reject non-admin', async (_name, resolve) => {
    for (const role of ['operator', 'viewer'] as const) {
      const error = await graphQLErrorOf(resolve(contextAs(role, ORG_A)));
      expect(error.extensions['code']).toBe('FORBIDDEN');
    }
    const noOrgAdmin = await graphQLErrorOf(resolve(contextAs('admin')));
    expect(noOrgAdmin.extensions['code']).toBe('FORBIDDEN');
    expect(pgCalls).toEqual([]);
    expect(cypherRuns).toEqual([]);
  });

  it('an admin with an organization claim still gets the cost summary', async () => {
    await expect(Query.costSummary(null, {}, contextAs('admin', ORG_A))).resolves.toMatchObject({ totalCIs: 0 });
  });
});
