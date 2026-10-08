// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant scoping for the TBM GraphQL resolvers (FD-2: Postgres
 * dim_business_services.organization_id is the tenant authority for
 * business-service ids; FD-16 c: the :BusinessService node must also carry
 * the caller's organization_id; global operations refuse every role).
 *
 * Postgres answers the ownership query from an in-memory table; Neo4j is a
 * recording session over a graph that applies each organization_id predicate
 * a statement actually contains: without it, every :BusinessService node is
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
  // Owned by org A in Postgres, but the node is org B's / has no organization.
  'bs-hijack': ORG_A,
  'bs-orphan': ORG_A,
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
const GRAPH_SERVICES: Record<string, { name: string; cost: number; tower: string; organizationId?: string }> = {
  'bs-a-app': { name: 'A App', cost: 100, tower: 'compute', organizationId: ORG_A },
  'bs-b-app': { name: 'B Secret App', cost: 7, tower: 'data', organizationId: ORG_B },
  'bs-hijack': { name: 'B Hijacked Node', cost: 5000, tower: 'data', organizationId: ORG_B },
  'bs-orphan': { name: 'Orphan Node', cost: 300, tower: 'network' },
};
// cap-1 is realized by every service node.
const CAPABILITY_SERVICES = ['bs-a-app', 'bs-b-app', 'bs-hijack', 'bs-orphan'];
const REALIZES_OWNED_FILTER = /WHERE service\.id IN \$orgServiceIds/;
const REALIZES_NODE_ORG_FILTER = /WHERE service\.id IN \$orgServiceIds AND service\.organization_id = \$organizationId/;
const SERVICE_NODE_ORG_FILTER = /MATCH \(service:BusinessService \{id: \$serviceId\}\)\s+WHERE service\.organization_id = \$organizationId\s/;
const int = (n: number) => ({ toNumber: () => n });
const neo4jSession = {
  run: async (query: string, params: Params = {}) => {
    cypherRuns.push({ query, params });
    // A statement without the node-org predicate matches every organization's node, as Neo4j would.
    const nodeInOrg = (id: string, filter: RegExp) =>
      !filter.test(query) || GRAPH_SERVICES[id]?.organizationId === params['organizationId'];
    if (query.includes('BusinessService {id: $serviceId}')) {
      const serviceId = params['serviceId'] as string;
      const service = GRAPH_SERVICES[serviceId];
      if (service === undefined || !nodeInOrg(serviceId, SERVICE_NODE_ORG_FILTER)) return { records: [] };
      return {
        records: [record({
          serviceId, serviceName: service.name, userCount: 0,
          totalCost: service.cost, ciCount: { toNumber: () => 1 }, towers: [],
        })],
      };
    }
    if (query.includes('BusinessCapability')) {
      if (params['capabilityId'] !== 'cap-1' && params['capabilityId'] !== 'cap-b') return { records: [] };
      // Without the filters on the REALIZES match, every realizing service is traversed.
      const allowed = REALIZES_OWNED_FILTER.test(query) ? (params['orgServiceIds'] as string[] | undefined) ?? [] : null;
      const services = (params['capabilityId'] === 'cap-b' ? ['bs-b-app'] : CAPABILITY_SERVICES).filter(id =>
        (allowed === null || allowed.includes(id)) && nodeInOrg(id, REALIZES_NODE_ORG_FILTER));
      if (services.length === 0 && query.includes('MATCH (cap:BusinessCapability {id: $capabilityId})-[:REALIZES]->')) return { records: [] };
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

  it('costsByBusinessService is NOT_FOUND for a node of another org or with no org', async () => {
    const asA = contextAs('viewer', ORG_A);
    const hijack = await graphQLErrorOf(Query.costsByBusinessService(null, { id: 'bs-hijack' }, asA));
    const orphan = await graphQLErrorOf(Query.costsByBusinessService(null, { id: 'bs-orphan' }, asA));
    const missing = await graphQLErrorOf(Query.costsByBusinessService(null, { id: 'bs-missing' }, asA));

    for (const error of [hijack, orphan]) {
      expect([error.message, error.extensions]).toEqual([missing.message, missing.extensions]);
    }
    // Postgres ownership passed for both, so the Cypher ran, bound to the token org.
    expect(cypherRuns.map(run => run.params)).toEqual([
      { serviceId: 'bs-hijack', organizationId: ORG_A },
      { serviceId: 'bs-orphan', organizationId: ORG_A },
    ]);
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
      expect([...(run.params['orgServiceIds'] as string[])].sort()).toEqual(['bs-a-app', 'bs-a-db', 'bs-hijack', 'bs-orphan']);
    }
  });

  it('costsByCapability excludes service nodes of other orgs', async () => {
    // bs-hijack (B's node) and bs-orphan (no org) are owned by A in Postgres and realize cap-1.
    const result = await Query.costsByCapability(null, { id: 'cap-1' }, contextAs('viewer', ORG_A));

    expect(result).toMatchObject({
      totalMonthlyCost: 100,
      supportingServices: 1,
      costByTower: [{ tower: 'compute', totalCost: 100, ciCount: 1 }],
    });
    expect(cypherRuns.map(run => run.params['organizationId'])).toEqual([ORG_A, ORG_A]);
  });

  it('foreign-only and missing capabilities share NOT_FOUND, while the owner can read', async () => {
    const a = contextAs('viewer', ORG_A);
    const foreign = await graphQLErrorOf(Query.costsByCapability(null, { id: 'cap-b' }, a));
    const missing = await graphQLErrorOf(Query.costsByCapability(null, { id: 'cap-missing' }, a));
    expect([foreign.message, foreign.extensions]).toEqual([missing.message, missing.extensions]);
    const own = await Query.costsByCapability(null, { id: 'cap-b' }, contextAs('viewer', ORG_B));
    expect(own).toMatchObject({ totalMonthlyCost: 7, supportingServices: 1 });
  });
});

describe('global TBM resolvers', () => {
  const GLOBAL: Array<[string, (context: GraphQLContext) => unknown]> = [
    ['costSummary', c => Query.costSummary(null, {}, c)],
    ['costsByTower', c => Query.costsByTower(null, {}, c)],
    ['costAllocations', c => Query.costAllocations(null, { ciId: 'ci-1' }, c)],
    ['licenses', c => Query.licenses(null, {}, c)],
    ['upcomingRenewals', c => Query.upcomingRenewals(null, {}, c)],
    ['allocateCosts', c => Mutation.allocateCosts(null, {
      input: { sourceId: 'ci-1', targetType: 'BUSINESS_SERVICE', targetIds: ['bs-a-app'] },
    }, c)],
    ['importGLData', c => Mutation.importGLData(null, {}, c)],
  ];

  it.each(GLOBAL)('%s: every tenant principal gets the same static denial without data access', async (_name, resolve) => {
    for (const context of [contextAs('admin', ORG_A), contextAs('admin', ORG_B), contextAs('admin'), contextAs('viewer', ORG_A)]) {
      const error = await graphQLErrorOf(Promise.resolve().then(() => resolve(context)));
      expect(error.message).toBe('Platform administrator access unavailable');
      expect(error.extensions['code']).toBe('FORBIDDEN');
    }
    expect(pgCalls).toEqual([]);
    expect(cypherRuns).toEqual([]);
    expect(neo4jSessionsOpened).toBe(0);
  });
});
