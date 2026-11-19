// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1928 (BW13): the pure composer of the deterministic happy-ui/v1 impact answer. The route, the organization scope
 * and the SQL are covered through the real routes in routes/__tests__/ci-org-scope.test.ts.
 */

jest.mock('@cmdb/database', () => ({ getPostgresClient: jest.fn() }));

import {
  assembleBusinessContext, deriveImpactRecommendations,
} from '../impact-business-context';
import { composeImpactAnswer, toJsonLines, type AnswerImpact, type HappyUILine } from '../ask-impact-answer';

const affected = (id: string, hops: number) => ({ ci_id: id, ci_name: `${id} name`, hop_count: hops });
const impact = (overrides: Partial<AnswerImpact> = {}): AnswerImpact => ({
  source_ci_id: 'src', source_ci_name: 'source', change_type: 'failover', risk_level: 'high', impact_score: 50,
  blast_radius: 2, affected_cis: [affected('a', 1), affected('b', 2)], critical_path: ['src', 'a', 'b'],
  estimated_downtime_minutes: 21, ...overrides,
});
const serviceRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  service_id: id, name: id, business_criticality: 'high' as const, lifecycle: 'live', annual_revenue: 8760, user_count: 5,
  ci_ids: ['a'], ...overrides,
});
const compose = (value: AnswerImpact, rows: Array<ReturnType<typeof serviceRow>> = []) => {
  const context = assembleBusinessContext(rows);
  return composeImpactAnswer({
    impact: value, context, recommendations: deriveImpactRecommendations(value, context.affected_business_services),
  });
};
const nodes = (lines: HappyUILine[]) => lines.filter(line => line.op === 'node') as Array<Record<string, any>>;
const node = (lines: HappyUILine[], id: string) => nodes(lines).find(candidate => candidate['id'] === id);
const statLabels = (lines: HappyUILine[]) => (node(lines, 'kpis')!['props'].items as Array<{ label: string }>).map(stat => stat.label);

describe('composeImpactAnswer', () => {
  it('is deterministic and a well-formed happy-ui/v1 stream: begin first, end last, every node after its parent', () => {
    const rows = [serviceRow('s1')];
    const first = compose(impact(), rows);
    expect(toJsonLines(first)).toBe(toJsonLines(compose(impact(), rows)));
    expect(first[0]).toEqual({ op: 'begin', $schema: 'happy-ui/v1', catalog: 'happy.core@1' });
    expect(first[first.length - 1]).toEqual({ op: 'end' });
    const seen = new Set<string>();
    for (const line of nodes(first)) {
      if (line['parent'] === undefined) expect(seen.size).toBe(0); // only the root has no parent, and it is first
      else expect(seen.has(line['parent'])).toBe(true);
      expect(seen.has(line['id'])).toBe(false);
      expect(String(line['id']).length).toBeLessThanOrEqual(64);
      seen.add(line['id']);
    }
    const text = toJsonLines(first);
    expect(text.endsWith('\n')).toBe(true);
    for (const raw of text.trim().split('\n')) expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('drives the topology: select and focus the source CI, then highlight its dependents', () => {
    const effects = compose(impact()).filter(line => line.op === 'effect').map(line => line['effect']);
    expect(effects).toEqual([
      { emit: 'select', detail: { id: 'src' } },
      { emit: 'focus', detail: { id: 'src' } },
      { emit: 'highlight', detail: { ids: ['a', 'b'], tone: 'warn' } },
    ]);
  });

  it('shows cost per hour and downtime only when they have backing data, never as 0', () => {
    const full = compose(impact(), [serviceRow('s1')]);
    expect(statLabels(full)).toEqual(['Risk', 'Dependent CIs', 'Cost per hour', 'Estimated downtime']);
    expect(node(full, 'unavailable')).toBeUndefined();

    const empty = compose(impact({ estimated_downtime_minutes: undefined, change_type: 'performance_tuning' }));
    expect(statLabels(empty)).toEqual(['Risk', 'Dependent CIs']);
    expect(node(empty, 'unavailable')!['props'].text).toMatch(/cost per hour.*estimated downtime/);
  });

  it('says a partial cost per hour is a lower bound and how many services back it', () => {
    const lines = compose(impact(), [serviceRow('priced'), serviceRow('unpriced', { annual_revenue: null })]);
    const cost = (node(lines, 'kpis')!['props'].items as Array<Record<string, any>>).find(stat => stat['label'] === 'Cost per hour')!;
    expect(cost['value']).toBe(1);
    expect(cost['delta'].text).toContain('1 of 2');
  });

  it('adds no service chain without services and no dependency chain without dependents', () => {
    const none = compose(impact({ blast_radius: 0, affected_cis: [], critical_path: ['src'] }));
    expect(node(none, 'services')).toBeUndefined();
    expect(node(none, 'chain')).toBeUndefined();
    expect(none.some(line => line.op === 'effect' && line['effect'].emit === 'highlight')).toBe(false);
    expect(node(none, 'rec-no_recorded_dependents')).toBeDefined();
  });

  it('keeps every chain within the catalog limits and skips ids the catalog would refuse', () => {
    const long = 'x'.repeat(65);
    const many = Array.from({ length: 15 }, (_, i) => serviceRow(`s${String(i).padStart(2, '0')}`));
    const lines = compose(impact({ affected_cis: [affected('a', 1), affected(long, 1)] }), many.concat(serviceRow(long)));
    const services = node(lines, 'services')!['props'];
    expect(services.items).toHaveLength(12);
    expect(services.caption).toContain('12 of 16');
    const highlight = lines.find(line => line.op === 'effect' && line['effect'].emit === 'highlight')!['effect'];
    expect(highlight.detail.ids).toEqual(['a']);
    for (const item of [...services.items, ...node(lines, 'chain')!['props'].items]) {
      expect((item.id ?? '').length).toBeLessThanOrEqual(64);
    }
  });

  it('names each hop of the longest chain from the selected CI', () => {
    const items = node(compose(impact()), 'chain')!['props'].items as Array<{ name: string; meta: string }>;
    expect(items.map(item => item.name)).toEqual(['source', 'a name', 'b name']);
    expect(items.map(item => item.meta)).toEqual(['selected CI', 'hop 1', 'hop 2']);
  });

  it('turns the rule-based recommendations into one Callout each, in rule order', () => {
    const lines = compose(impact({ risk_level: 'critical' }), [serviceRow('s1')]);
    const ids = nodes(lines).filter(line => line['type'] === 'Callout').map(line => line['id']);
    expect(ids).toEqual(['rec-maintenance_window', 'rec-notify_dependents', 'rec-notify_service_owners', 'rec-verify_standby']);
  });
});
