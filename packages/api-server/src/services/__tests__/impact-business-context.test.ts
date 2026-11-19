// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1927 (BW11, BW12): the pure rules of the impact business context. The SQL and the route wiring (organization scope,
 * payload keys) are covered through the real routes in routes/__tests__/ci-org-scope.test.ts.
 */

jest.mock('@cmdb/database', () => ({ getPostgresClient: jest.fn() }));

import { ChangeType, RiskLevel, ImpactType, type ImpactAnalysis } from '@cmdb/ai-ml-engine';
import {
  assembleBusinessContext, costPerHour, deriveImpactRecommendations,
} from '../impact-business-context';

const affected = (id: string, hops: number) => ({
  ci_id: id, ci_name: id, ci_type: 'server', impact_type: hops === 1 ? ImpactType.DIRECT : ImpactType.INDIRECT,
  dependency_path: ['src', id], hop_count: hops, impact_probability: 90, estimated_impact: '', direction: 'downstream' as const,
});

const impact = (overrides: Partial<ImpactAnalysis> = {}): ImpactAnalysis => ({
  id: 'i', source_ci_id: 'src', source_ci_name: 'src', change_type: ChangeType.RESTART, impact_score: 10,
  affected_cis: [affected('a', 1)], blast_radius: 1, critical_path: ['src', 'a'], risk_level: RiskLevel.LOW,
  analyzed_at: new Date(0), ...overrides,
});

const ids = (value: ImpactAnalysis, services: Array<{ business_criticality: 'critical' | 'high' | 'medium' | 'low' }> = []) =>
  deriveImpactRecommendations(value, services).map(recommendation => recommendation.id);

describe('costPerHour', () => {
  it('is annual revenue over 8760 hours rounded to cents, and null without revenue', () => {
    expect(costPerHour(8_760_000)).toBe(1000);
    expect(costPerHour(1_000_000)).toBe(114.16);
    expect(costPerHour(null)).toBeNull();
  });
});

describe('assembleBusinessContext', () => {
  const row = (overrides: Record<string, unknown>) => ({
    service_id: 's', name: 'S', business_criticality: 'medium' as const, lifecycle: 'live', annual_revenue: null,
    user_count: null, ci_ids: ['c'], ...overrides,
  });

  it('sorts by criticality then name, and counts a service mapped through several CIs once', () => {
    const context = assembleBusinessContext([
      row({ service_id: 'l', name: '0 low (first by name)', business_criticality: 'low', annual_revenue: 8760 }),
      row({ service_id: 'c2', name: 'B crit', business_criticality: 'critical', annual_revenue: 8760, ci_ids: ['y', 'x'] }),
      row({ service_id: 'c1', name: 'A crit', business_criticality: 'critical', annual_revenue: 17_520 }),
    ]);
    expect(context.affected_business_services.map(s => s.service_id)).toEqual(['c1', 'c2', 'l']);
    expect(context.affected_business_services[1]!.affected_ci_ids).toEqual(['x', 'y']);
    expect(context.cost_per_hour).toBe(4); // (17520 + 8760 + 8760) / 8760
    expect(context.cost_per_hour_services_priced).toBe(3);
  });

  it('prices only services with revenue, so a partial total is a lower bound with the count that backs it', () => {
    const context = assembleBusinessContext([row({ service_id: 'p', annual_revenue: 8760 }), row({ service_id: 'u' })]);
    expect(context.cost_per_hour).toBe(1);
    expect(context.cost_per_hour_services_priced).toBe(1);
    expect(context.unavailable).toEqual(['affected_business_services[].cost_per_hour', 'affected_business_services[].users']);
  });

  it('reports users only for a positive number, truncated to an integer', () => {
    const [first, second, third] = assembleBusinessContext([
      row({ service_id: 'a', user_count: 12.9 }), row({ service_id: 'b', user_count: 0 }), row({ service_id: 'c', user_count: '40' }),
    ]).affected_business_services;
    expect([first!.users, second!.users, third!.users]).toEqual([12, null, 40]);
  });
});

describe('deriveImpactRecommendations', () => {
  it('lists the recommendations in rule order', () => {
    const value = impact({ change_type: ChangeType.DECOMMISSION, risk_level: RiskLevel.CRITICAL, critical_path: ['a', 'b', 'c', 'd'] });
    const services = [{ business_criticality: 'high' as const }];
    expect(ids(value, services)).toEqual([
      'maintenance_window', 'notify_dependents', 'notify_service_owners', 'rollback_plan', 'clear_dependents_first',
      'review_dependency_chain',
    ]);
  });

  it('asks for a maintenance window on high risk or an estimated downtime of 30 minutes or more, not below', () => {
    expect(ids(impact({ risk_level: RiskLevel.HIGH }))).toContain('maintenance_window');
    expect(ids(impact({ estimated_downtime_minutes: 30 }))).toContain('maintenance_window');
    expect(ids(impact({ estimated_downtime_minutes: 29, risk_level: RiskLevel.MEDIUM }))).not.toContain('maintenance_window');
  });

  it('notifies service owners only for critical or high-criticality services', () => {
    expect(ids(impact(), [{ business_criticality: 'medium' }, { business_criticality: 'low' }])).not.toContain('notify_service_owners');
    expect(ids(impact(), [{ business_criticality: 'critical' }])).toContain('notify_service_owners');
  });

  it('asks for a standby check on failover only, and a rollback plan only for risky non-minimal changes', () => {
    expect(ids(impact({ change_type: ChangeType.FAILOVER }))).toContain('verify_standby');
    expect(ids(impact({ change_type: ChangeType.RESTART }))).not.toContain('verify_standby');
    expect(ids(impact({ change_type: ChangeType.VERSION_UPGRADE }))).toContain('rollback_plan');
    expect(ids(impact({ change_type: ChangeType.VERSION_UPGRADE, risk_level: RiskLevel.MINIMAL }))).not.toContain('rollback_plan');
    expect(ids(impact({ change_type: ChangeType.RESTART }))).not.toContain('rollback_plan');
  });

  it('says no dependents are recorded, not that there are none, when the blast radius is 0', () => {
    const none = impact({ affected_cis: [], blast_radius: 0, critical_path: ['src'] });
    expect(ids(none)).toEqual(['no_recorded_dependents']);
    expect(ids(impact())).not.toContain('no_recorded_dependents');
  });

  it('flags a dependency chain of 3 or more hops', () => {
    expect(ids(impact({ critical_path: ['a', 'b', 'c', 'd'] }))).toContain('review_dependency_chain');
    expect(ids(impact({ critical_path: ['a', 'b', 'c'] }))).not.toContain('review_dependency_chain');
  });
});
