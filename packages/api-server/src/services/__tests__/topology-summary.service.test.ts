// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Estate topology summary: category table, limit clamping and result assembly. The Cypher itself
 * (tenant scope, ordering, status filter, edge membership) is exercised against a real graph in
 * tests/integration/topology-summary.test.ts.
 */

import neo4j, { type Session } from 'neo4j-driver';
import { topologyCategoryOf } from '@cmdb/common';
import { CIListUnavailableError } from '../../read-admission';
import { MAX_DASHBOARD_GROUPS } from '../dashboard-query';
import {
  clampLimit, parseTopologyOptions, readTopologySummary, TopologyGroupLimitError,
} from '../topology-summary.service';

const row = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] });

interface Canned {
  groups: Array<{ type: string | null; cis: number; critical: number }>;
  relationships?: number;
  nodes?: Array<Record<string, unknown>>;
  edges?: Array<{ source: string; target: string; type: string }>;
}

/** A session that answers the four summary statements, told apart by their parameters. */
function sessionWith(canned: Canned): { session: Session } {
  const session = {
    run: async (_query: string, params: Record<string, unknown>) => {
      if ('groupLimit' in params) {
        return { records: canned.groups.map(g => row({ type: g.type, cis: neo4j.int(g.cis), critical: neo4j.int(g.critical) })) };
      }
      if ('nodeLimit' in params) return { records: (canned.nodes ?? []).map(row) };
      if ('edgeLimit' in params) {
        const cap = (params['edgeLimit'] as { toNumber(): number }).toNumber();
        return { records: (canned.edges ?? []).slice(0, cap).map(row) };
      }
      return { records: [row({ relationships: neo4j.int(canned.relationships ?? 0) })] };
    },
  };
  return { session: session as unknown as Session };
}

const options = { nodeLimit: 200, edgeLimit: 2, includeInactive: false };
const node = (id: string) => ({ id, name: id, type: 'server', status: 'active', critical: false });

describe('topology category table', () => {
  it('places the headline types in their rings', () => {
    expect(['service', 'application', 'database', 'storage', 'server', 'virtual-machine']
      .map(type => topologyCategoryOf(type).category))
      .toEqual(['services', 'apps', 'data', 'data', 'infra', 'infra']);
  });

  it.each(['quantum-router', '', 'constructor', 'toString', '__proto__', null, undefined])(
    'counts unknown type %p under infra and flags it unmapped', type => {
      expect(topologyCategoryOf(type as string)).toEqual({ category: 'infra', mapped: false });
    });
});

describe('topology limits', () => {
  it('clamps to 1..max and falls back to the default for absent or non-numeric input', () => {
    expect([clampLimit('9999', 200, 500), clampLimit('0', 200, 500), clampLimit('-5', 200, 500), clampLimit('37', 200, 500)])
      .toEqual([500, 1, 1, 37]);
    expect([clampLimit(undefined, 200, 500), clampLimit('abc', 200, 500), clampLimit('1.5', 200, 500),
      clampLimit(['3', '4'], 200, 500), clampLimit('99999999999999999999', 200, 500)])
      .toEqual([200, 200, 200, 200, 200]);
  });

  it('applies node and edge caps and only a literal includeInactive=true', () => {
    expect(parseTopologyOptions({})).toEqual({ nodeLimit: 200, edgeLimit: 400, includeInactive: false });
    expect(parseTopologyOptions({ limit: '100000', edge_limit: '100000', includeInactive: 'true' }))
      .toEqual({ nodeLimit: 500, edgeLimit: 1000, includeInactive: true });
    expect(parseTopologyOptions({ includeInactive: '1' }).includeInactive).toBe(false);
  });
});

describe('readTopologySummary assembly', () => {
  it('sums per-category counts, counts critical across categories and lists unmapped types', async () => {
    const { session } = sessionWith({ groups: [
      { type: 'server', cis: 3, critical: 1 }, { type: 'service', cis: 2, critical: 2 },
      { type: 'application', cis: 4, critical: 0 }, { type: 'database', cis: 1, critical: 1 },
      { type: 'zeta-box', cis: 2, critical: 0 }, { type: 'alpha-box', cis: 1, critical: 0 },
      { type: null, cis: 1, critical: 0 },
    ], relationships: 9 });

    const summary = await readTopologySummary(session, 'org', options, [], 10_000);

    expect(summary.categories).toEqual({ services: 2, apps: 4, data: 1, infra: 3 + 2 + 1 + 1, critical: 4 });
    expect(summary.unmapped_types).toEqual(['(missing)', 'alpha-box', 'zeta-box']);
    expect(summary.totals).toMatchObject({ cis: 14, relationships: 9 });
  });

  it('labels each sampled node with its category and a null health', async () => {
    const { session } = sessionWith({
      groups: [{ type: 'database', cis: 2, critical: 0 }],
      nodes: [{ ...node('a'), type: 'database' }, { ...node('b'), type: 'mystery' }],
    });
    const summary = await readTopologySummary(session, 'org', options, [], 10_000);
    expect(summary.nodes.map(n => [n.id, n.category, n.health])).toEqual([['a', 'data', null], ['b', 'infra', null]]);
  });

  it('is truncated when the node cap cut CIs, and not when everything fit', async () => {
    const cut = await readTopologySummary(sessionWith({
      groups: [{ type: 'server', cis: 3, critical: 0 }], nodes: [node('a'), node('b')],
    }).session, 'org', options, [], 10_000);
    expect(cut.totals).toMatchObject({ cis: 3, nodes_returned: 2, truncated: true });

    const whole = await readTopologySummary(sessionWith({
      groups: [{ type: 'server', cis: 2, critical: 0 }], nodes: [node('a'), node('b')],
      edges: [{ source: 'a', target: 'b', type: 'DEPENDS_ON' }],
    }).session, 'org', options, [], 10_000);
    expect(whole.totals).toMatchObject({ nodes_returned: 2, edges_returned: 1, truncated: false });
  });

  it('is truncated, with exactly edgeLimit edges, when more edges exist than the edge cap', async () => {
    const edges = ['x', 'y', 'z'].map(target => ({ source: 'a', target, type: 'DEPENDS_ON' }));
    const exact = await readTopologySummary(sessionWith({
      groups: [{ type: 'server', cis: 1, critical: 0 }], nodes: [node('a')], edges: edges.slice(0, 2),
    }).session, 'org', options, [], 10_000);
    expect(exact.totals).toMatchObject({ edges_returned: 2, truncated: false });

    const over = await readTopologySummary(sessionWith({
      groups: [{ type: 'server', cis: 1, critical: 0 }], nodes: [node('a')], edges,
    }).session, 'org', options, [], 10_000);
    expect(over.edges).toEqual(edges.slice(0, 2));
    expect(over.totals).toMatchObject({ edges_returned: 2, truncated: true });
  });

  it('reads edges only when the sample has nodes', async () => {
    const summary = await readTopologySummary(sessionWith({
      groups: [], edges: [{ source: 'ghost', target: 'ghost', type: 'DEPENDS_ON' }],
    }).session, 'org', options, [], 10_000);
    expect(summary.edges).toEqual([]);
    expect(summary.totals).toMatchObject({ cis: 0, nodes_returned: 0, edges_returned: 0, truncated: false });
  });

  it('refuses rather than truncates a group set larger than the dashboard group cap', async () => {
    const groups = Array.from({ length: MAX_DASHBOARD_GROUPS + 1 }, (_, i) => ({ type: `type-${i}`, cis: 1, critical: 0 }));
    await expect(readTopologySummary(sessionWith({ groups }).session, 'org', options, [], 10_000))
      .rejects.toBeInstanceOf(TopologyGroupLimitError);
  });

  it('refuses with the list-unavailable error once the readCIList budget is spent', async () => {
    await expect(readTopologySummary(sessionWith({ groups: [] }).session, 'org', options, [], 0))
      .rejects.toBeInstanceOf(CIListUnavailableError);
  });
});
