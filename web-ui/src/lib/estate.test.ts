// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1252 S2 (HAP-1916): the rules the estate hub relies on, as behaviour.
import { describe, expect, it } from 'vitest';
import {
  ORBIT_CENTER,
  ORBIT_RINGS,
  buildSample,
  categoryCounts,
  categoryOf,
  classifyError,
  incidentFacts,
  isDimmed,
  leadIncident,
  orbitLayout,
  shortIncidentNumber,
  type IncidentRow,
  type RelationshipRow,
} from './estate';

const rel = (from: string, to: string, type = 'DEPENDS_ON'): RelationshipRow => ({
  from_id: from,
  from_name: `name-${from}`,
  from_type: 'application',
  to_id: to,
  to_name: `name-${to}`,
  to_type: 'database',
  type,
});
const ci = (id: string, type = 'server') => ({ id, name: `name-${id}`, type });

describe('categories', () => {
  it('maps the ten CI types onto the four stage categories, unknown types to infra', () => {
    expect(
      ['service', 'application', 'database', 'storage', 'server', 'load-balancer', 'whatever'].map(
        categoryOf
      )
    ).toEqual(['services', 'apps', 'data', 'data', 'infra', 'infra', 'infra']);
  });

  it('adds the full-estate by_type counts per category', () => {
    expect(
      categoryCounts({ database: 5, storage: 2, server: 10, container: 1, application: 3 })
    ).toEqual({
      services: 0,
      apps: 3,
      data: 7,
      infra: 11,
    });
  });

  it('dims everything outside the chosen category, nothing without a filter', () => {
    expect(isDimmed('apps', null)).toBe(false);
    expect(isDimmed('apps', 'apps')).toBe(false);
    expect(isDimmed('data', 'apps')).toBe(true);
  });
});

describe('buildSample', () => {
  it('keeps connected CIs ahead of the list and never exceeds the cap', () => {
    const sample = buildSample([ci('a'), ci('b'), ci('c'), ci('d')], [rel('x', 'y')], 3);
    expect(sample.nodes.map((n) => n.id)).toEqual(['x', 'y', 'a']);
    expect(sample.nodes.length).toBeLessThanOrEqual(3);
  });

  it('takes relationship endpoints that are not in the CI list, typed from the relationship row', () => {
    const sample = buildSample([], [rel('x', 'y')]);
    expect(sample.nodes).toEqual([
      { id: 'x', name: 'name-x', type: 'application', category: 'apps' },
      { id: 'y', name: 'name-y', type: 'database', category: 'data' },
    ]);
    expect(sample.edges).toEqual([{ source: 'x', target: 'y', type: 'DEPENDS_ON' }]);
  });

  it('drops an edge whose endpoint did not fit, so nothing is drawn to a missing node', () => {
    const sample = buildSample([], [rel('a', 'b'), rel('c', 'd')], 3);
    expect(sample.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(sample.edges).toEqual([{ source: 'a', target: 'b', type: 'DEPENDS_ON' }]);
  });

  it('keeps an edge between two list CIs that were only added by the fill', () => {
    const sample = buildSample([ci('a'), ci('b')], [rel('a', 'b')], 1);
    expect(sample.edges).toEqual([]);
    expect(buildSample([ci('a'), ci('b')], [rel('a', 'b')], 2).edges).toHaveLength(1);
  });

  it('counts a CI that appears in both sources once and a repeated relationship once', () => {
    const sample = buildSample(
      [ci('x'), ci('y')],
      [rel('x', 'y'), rel('x', 'y'), rel('x', 'y', 'HOSTS')]
    );
    expect(sample.nodes).toHaveLength(2);
    expect(sample.edges.map((e) => e.type)).toEqual(['DEPENDS_ON', 'HOSTS']);
  });
});

describe('orbitLayout', () => {
  it('puts every dot on the ellipse of its own category', () => {
    const nodes = buildSample(
      ['service', 'application', 'database', 'server'].flatMap((type) => [
        ci(`${type}-1`, type),
        ci(`${type}-2`, type),
      ]),
      []
    ).nodes;
    const layout = orbitLayout(nodes);
    expect(layout.size).toBe(8);
    for (const n of nodes) {
      const ring = ORBIT_RINGS.find((r) => r.category === n.category)!;
      const p = layout.get(n.id)!;
      const onEllipse =
        ((p.x - ORBIT_CENTER.x) / ring.rx) ** 2 + ((p.y - ORBIT_CENTER.y) / ring.ry) ** 2;
      expect(onEllipse).toBeCloseTo(1, 6);
    }
  });

  it('spreads the members of one ring to distinct positions', () => {
    const nodes = buildSample([ci('a'), ci('b'), ci('c')], []).nodes;
    const spots = new Set(
      [...orbitLayout(nodes).values()].map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`)
    );
    expect(spots.size).toBe(3);
  });
});

describe('classifyError', () => {
  it('reports a 403 with the reason the server gave', () => {
    const forbidden = {
      response: {
        status: 403,
        data: { _error: 'Forbidden', _message: "Permission 'read' required" },
      },
    };
    expect(classifyError(forbidden)).toEqual({
      kind: 'forbidden',
      message: "Permission 'read' required",
    });
  });

  it('keeps every other failure as an error with its message', () => {
    expect(
      classifyError(Object.assign(new Error('boom'), { response: { status: 500, data: {} } }))
    ).toEqual({ kind: 'error', message: 'boom' });
    expect(classifyError('x')).toEqual({ kind: 'error', message: 'Request failed' });
  });
});

describe('incident ribbon rules', () => {
  const row = (over: Partial<IncidentRow>): IncidentRow => ({
    id: 'i',
    incident_number: 'INC-1',
    title: 't',
    priority: 3,
    status: 'new',
    affected_ci_id: null,
    reported_at: '2026-11-12T10:00:00Z',
    ...over,
  });
  const now = Date.parse('2026-11-12T10:14:00Z');

  it('leads with the highest priority, then the most recently reported', () => {
    const lead = leadIncident([
      row({ id: 'p3-new', priority: 3, reported_at: '2026-11-12T09:59:00Z' }),
      row({ id: 'p1-old', priority: 1, reported_at: '2026-11-12T08:00:00Z' }),
      row({ id: 'p1-new', priority: 1, reported_at: '2026-11-12T09:00:00Z' }),
    ]);
    expect(lead?.id).toBe('p1-new');
    expect(leadIncident([])).toBeNull();
  });

  it('never shows a zero users or revenue figure: the stored default means "not estimated"', () => {
    const zeros = row({
      business_impact: { estimated_user_impact: 0, estimated_revenue_impact: 0 },
    });
    expect(incidentFacts(zeros, now)).toEqual(['P3', 'opened 14 min ago']);
    expect(incidentFacts(row({ business_impact: null }), now)).toEqual(['P3', 'opened 14 min ago']);
  });

  it('shows users and revenue impact when the incident carries them', () => {
    const facts = incidentFacts(
      row({ business_impact: { estimated_user_impact: 18420, estimated_revenue_impact: 212000 } }),
      now
    );
    expect(facts).toEqual([
      'P3',
      'opened 14 min ago',
      '18,420 users affected',
      '$212K est. revenue impact',
    ]);
  });

  it('shortens only the generated INC-<uuid> number', () => {
    expect(shortIncidentNumber('INC-8f3c2a10-1111-4222-8333-444455556666')).toBe('INC-8f3c2a10');
    expect(shortIncidentNumber('INC-20481')).toBe('INC-20481');
  });
});
