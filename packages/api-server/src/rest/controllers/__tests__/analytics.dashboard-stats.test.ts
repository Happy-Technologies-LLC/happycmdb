// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * GET /analytics/dashboard payload honesty (BW4): `health_score` is null (no CI health state exists, and 0 reads
 * as "everything is down") and `critical_relationships` counts relationships touching a critical CI
 * (bsm_business_criticality tier_1 or tier_2), not every relationship.
 *
 * Neo4j is an in-memory graph behind a fake session that evaluates the statements the controller issues over
 * that graph and honours the predicates each statement actually contains: a statement without the organization
 * predicate sees every organization's nodes, and one without the critical-tier predicate counts every edge.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Request, Response } from 'express';
import neo4j from 'neo4j-driver';

jest.mock('@cmdb/common', () => ({
  logger: { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));
jest.mock('@cmdb/database', () => ({ getNeo4jClient: jest.fn(), getPostgresClient: jest.fn() }));
// The auth middleware imported by the controller pulls in bcrypt's native binding, unused here.
jest.mock('bcrypt', () => ({}));

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { AnalyticsController } from '../analytics.controller';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

type Props = Record<string, unknown>;
const nodes = new Map<string, Props>();
let edges: Array<{ from: string; to: string }> = [];

function ci(id: string, organizationId: string, extra: Props = {}): void {
  nodes.set(id, { id, name: id, type: 'server', status: 'active', environment: 'production',
    organization_id: organizationId, ...extra });
}
const link = (from: string, to: string) => edges.push({ from, to });

const rec = (row: Record<string, unknown>) => ({ get: (key: string) => row[key] });

function run(rawCypher: string, params: Props): Array<ReturnType<typeof rec>> {
  const cypher = rawCypher.replace(/\s+/g, ' ').trim();
  const scoped = (props: Props, variable: string) =>
    !cypher.includes(`${variable}.organization_id = $organizationId`) || props['organization_id'] === params['organizationId'];
  const own = [...nodes.values()].filter(props => scoped(props, 'ci'));

  if (cypher.includes('COUNT(r) as critical_relationships')) {
    const tiers = params['criticalTiers'] as string[];
    const isCritical = (props: Props) => tiers.includes(props['bsm_business_criticality'] as string);
    // Only the endpoints the statement actually tests for criticality are tested; none means every edge counts.
    const testsSource = cypher.includes('source.bsm_business_criticality IN $criticalTiers');
    const testsTarget = cypher.includes('target.bsm_business_criticality IN $criticalTiers');
    const count = edges.filter(edge => {
      const source = nodes.get(edge.from)!;
      const target = nodes.get(edge.to)!;
      if (!scoped(source, 'source') || !scoped(target, 'target')) return false;
      if (!testsSource && !testsTarget) return true;
      return (testsSource && isCritical(source)) || (testsTarget && isCritical(target));
    }).length;
    return [rec({ critical_relationships: neo4j.int(count) })];
  }
  if (cypher.includes('COUNT(ci) as total_cis')) return [rec({ total_cis: neo4j.int(own.length) })];
  if (cypher.includes('ci.discovered_at DESC')) return [];
  const grouped = (field: string) => {
    const counts = new Map<unknown, number>();
    for (const props of own) if (props[field] !== undefined) counts.set(props[field], (counts.get(props[field]) ?? 0) + 1);
    return [...counts].map(([key, count]) => rec({ [field === 'type' ? 'ci_type' : field]: key, count: neo4j.int(count) }));
  };
  if (cypher.includes('ci.type as ci_type')) return grouped('type');
  if (cypher.includes('ci.status as status')) return grouped('status');
  if (cypher.includes('ci.environment as environment')) return grouped('environment');
  throw new Error(`fake Neo4j: unrecognised statement: ${cypher}`);
}

function res(): Response & { body?: unknown } {
  const out = { status: jest.fn().mockReturnThis(), json: jest.fn((body: unknown) => { out.body = body; return out; }) };
  return out as unknown as Response & { body?: unknown };
}

async function dashboard(organizationId: string): Promise<Record<string, unknown>> {
  const response = res();
  await new AnalyticsController().getDashboardStats(
    { user: { _organizationId: organizationId } } as unknown as Request, response);
  expect(response.status).not.toHaveBeenCalled();
  return response.body as Record<string, unknown>;
}

describe('getDashboardStats: health_score and critical_relationships', () => {
  beforeEach(() => {
    nodes.clear();
    edges = [];
    (getPostgresClient as jest.Mock).mockReturnValue({ query: jest.fn() });
    (getNeo4jClient as jest.Mock).mockReturnValue({
      getSession: () => ({ run: async (cypher: string, params: Props) => ({ records: run(cypher, params) }), close: async () => undefined }),
    });
  });

  it('with no CIs: health_score is null and critical_relationships is 0', async () => {
    const body = await dashboard(ORG_A);
    expect(body['total_cis']).toBe(0);
    expect(body['health_score']).toBeNull();
    expect(body['critical_relationships']).toBe(0);
  });

  it('with CIs and relationships but no critical CI: critical_relationships is 0, not the relationship total', async () => {
    ci('a', ORG_A, { bsm_business_criticality: 'tier_3' });
    ci('b', ORG_A, { bsm_business_criticality: 'tier_4' });
    ci('c', ORG_A);
    link('a', 'b');
    link('b', 'c');
    const body = await dashboard(ORG_A);
    expect(body['total_cis']).toBe(3);
    expect(body['critical_relationships']).toBe(0);
    expect(body['health_score']).toBeNull();
  });

  it('counts exactly the relationships that touch a tier_1 or tier_2 CI, once each, whichever end it is on', async () => {
    ci('crit1', ORG_A, { bsm_business_criticality: 'tier_1' });
    ci('crit2', ORG_A, { bsm_business_criticality: 'tier_2' });
    ci('t3', ORG_A, { bsm_business_criticality: 'tier_3' });
    ci('plain', ORG_A);
    link('crit1', 't3'); // critical source
    link('plain', 'crit2'); // critical target
    link('crit1', 'crit2'); // both ends critical: still one relationship
    link('t3', 'plain'); // touches no critical CI
    link('plain', 't3'); // touches no critical CI
    const body = await dashboard(ORG_A);
    expect(edges).toHaveLength(5);
    expect(body['critical_relationships']).toBe(3);
  });

  it("never counts another organization's critical relationships, nor an edge that crosses organizations", async () => {
    ci('a-crit', ORG_A, { bsm_business_criticality: 'tier_1' });
    ci('a-plain', ORG_A);
    ci('b-crit', ORG_B, { bsm_business_criticality: 'tier_1' });
    ci('b-plain', ORG_B);
    link('a-crit', 'a-plain');
    link('b-crit', 'b-plain');
    link('b-crit', 'a-plain'); // cross-organization edge
    expect((await dashboard(ORG_A))['critical_relationships']).toBe(1);
    expect((await dashboard(ORG_B))['critical_relationships']).toBe(1);
  });
});
