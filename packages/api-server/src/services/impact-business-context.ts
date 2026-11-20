// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1927 (UX-4b BW11, BW12): the business side of an impact read, derived at read time and never stored.
 *
 * BW11, affected business services: the services the CI changed or failed, or any CI downstream of it, is mapped to.
 * The mapping is `ci_business_service_mappings` joined to `dim_business_services` (the organization-scoped portfolio
 * table) and to the current, owned `cmdb.dim_ci` row, with the same pending/failed reconciliation exclusion as
 * `GET /business-services/:id/cis`. Both the service and the CI must belong to the caller's organization, so another
 * organization's service, or a mapping to another organization's CI, is never counted or returned. A `retired` service
 * is not affected by anything and is skipped. Service-to-service dependencies are not walked: only services mapped to a
 * CI in the traversal are listed.
 *
 * Cost per hour (decision N3 (a)): `annual revenue / 8760` (hours in a non-leap year). The total is the sum of the priced
 * services' annual revenue divided by 8760 and rounded to cents once, so it may differ from the sum of the per-service
 * `cost_per_hour` values, which are each rounded on their own, by up to half a cent per priced service. Revenue and users are read from the service's free-form
 * `metadata` JSON (`annual_revenue_supported`, `user_count`; a positive number or numeric string). There is no typed
 * column and no other organization-scoped source: the BSM `business_services.bsm_attributes` table has no organization
 * column and is not linked to `dim_business_services`. A value that is missing, not numeric or not positive (0 is the
 * BSM "unset" default) is `null` and listed in `unavailable`; it is never 0. The total is `null` when no affected
 * service has revenue; when only some do it is a lower bound, and `cost_per_hour_services_priced` says how many counted.
 */

import { getPostgresClient } from '@cmdb/database';

const HOURS_PER_YEAR = 8760;
const CRITICALITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

export interface AffectedBusinessService {
  service_id: string;
  name: string;
  business_criticality: (typeof CRITICALITY_ORDER)[number];
  lifecycle: string;
  /** `metadata.user_count` of the service; null when not recorded. */
  users: number | null;
  /** `metadata.annual_revenue_supported` of the service; null when not recorded. */
  annual_revenue: number | null;
  /** annual_revenue / 8760, rounded to cents; null when `annual_revenue` is null. */
  cost_per_hour: number | null;
  /** The CIs of the traversal this service is mapped to, sorted. */
  affected_ci_ids: string[];
}

export interface ImpactBusinessContext {
  affected_business_services: AffectedBusinessService[];
  cost_per_hour: number | null;
  cost_per_hour_services_priced: number;
  /** Fields with no backing data: `cost_per_hour`, `affected_business_services[].cost_per_hour`, `affected_business_services[].users`. */
  unavailable: string[];
}

/** A positive finite number from a JSON number or numeric string, else null. */
function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function costPerHour(annualRevenue: number | null): number | null {
  return annualRevenue === null ? null : Math.round((annualRevenue / HOURS_PER_YEAR) * 100) / 100;
}

interface ServiceRow {
  service_id: string;
  name: string;
  business_criticality: AffectedBusinessService['business_criticality'];
  lifecycle: string;
  annual_revenue: unknown;
  user_count: unknown;
  ci_ids: string[];
}

/** Pure assembly of the response block from the per-service rows, so the rule is testable without a database. */
export function assembleBusinessContext(rows: readonly ServiceRow[]): ImpactBusinessContext {
  const services: AffectedBusinessService[] = rows.map(row => {
    const annualRevenue = positiveNumber(row.annual_revenue);
    const users = positiveNumber(row.user_count);
    return {
      service_id: row.service_id,
      name: row.name,
      business_criticality: row.business_criticality,
      lifecycle: row.lifecycle,
      users: users === null ? null : Math.floor(users),
      annual_revenue: annualRevenue,
      cost_per_hour: costPerHour(annualRevenue),
      affected_ci_ids: [...row.ci_ids].sort(),
    };
  }).sort((a, b) =>
    CRITICALITY_ORDER.indexOf(a.business_criticality) - CRITICALITY_ORDER.indexOf(b.business_criticality)
    || a.name.localeCompare(b.name) || a.service_id.localeCompare(b.service_id));

  const priced = services.filter(service => service.annual_revenue !== null);
  const total = priced.length === 0
    ? null
    : Math.round(priced.reduce((sum, service) => sum + service.annual_revenue!, 0) / HOURS_PER_YEAR * 100) / 100;
  const unavailable: string[] = [];
  if (total === null) unavailable.push('cost_per_hour');
  if (services.some(service => service.cost_per_hour === null)) unavailable.push('affected_business_services[].cost_per_hour');
  if (services.some(service => service.users === null)) unavailable.push('affected_business_services[].users');
  return {
    affected_business_services: services,
    cost_per_hour: total,
    cost_per_hour_services_priced: priced.length,
    unavailable,
  };
}

/**
 * The business context of an impact over `ciIds` (the source CI and the CIs the traversal reached), all of them from the
 * caller's own organization-scoped traversal. One indexed statement under its own statement_timeout; a timeout rejects
 * with SQLSTATE 57014 and callers answer 504 like the other impact reads.
 */
export async function loadImpactBusinessContext(
  organizationId: string, ciIds: Iterable<string>, options: { timeoutMs: number }
): Promise<ImpactBusinessContext> {
  const ids = [...new Set(ciIds)];
  if (ids.length === 0) return assembleBusinessContext([]);
  const result = await getPostgresClient().transaction(async client => {
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(options.timeoutMs)]);
    return client.query(
      `SELECT s.service_id, s.name, s.business_criticality, s.lifecycle,
              s.metadata->'annual_revenue_supported' AS annual_revenue, s.metadata->'user_count' AS user_count,
              array_agg(DISTINCT m.ci_id) AS ci_ids
       FROM ci_business_service_mappings m
       JOIN dim_business_services s ON s.service_id = m.service_id AND s.organization_id = $2 AND s.lifecycle <> 'retired'
       JOIN cmdb.dim_ci c ON c.ci_id = m.ci_id AND c.is_current AND NOT c.org_backfilled AND c.organization_id = $2
       WHERE m.ci_id = ANY($1::text[])
         AND NOT EXISTS (
           SELECT 1 FROM ci_reconciliation_operations j
           WHERE j.organization_id = $2 AND j.ci_id = m.ci_id AND j.state IN ('pending','failed'))
       GROUP BY s.service_id, s.name, s.business_criticality, s.lifecycle, s.metadata`,
      [ids, organizationId]);
  });
  return assembleBusinessContext(result.rows as ServiceRow[]);
}

export interface ImpactRecommendation {
  id: string;
  message: string;
}

const MAINTENANCE_WINDOW_DOWNTIME_MINUTES = 30;
const LONG_CHAIN_HOPS = 3;
/** The engine's `ChangeType` values, as strings so this service (reached from the controllers the e2e type-check imports) needs no ai-ml-engine build. */
const ROLLBACK_CHANGE_TYPES: ReadonlySet<string> = new Set([
  'configuration_change', 'version_upgrade', 'network_change', 'security_change', 'decommission',
]);

/** The fields of the engine's `ImpactAnalysis` the rules read. */
export interface RecommendationInput {
  change_type: string;
  risk_level: string;
  blast_radius: number;
  affected_cis: ReadonlyArray<{ hop_count: number }>;
  critical_path: readonly string[];
  estimated_downtime_minutes?: number | undefined;
}

/**
 * BW12: deterministic, rule-based recommendations for a predicted change. No model, no randomness, no I/O: the same
 * `impact` and `services` always give the same list, in rule order. Each rule fires on fields of the response itself:
 *
 *  - `maintenance_window`: risk_level is critical or high, or estimated_downtime_minutes >= 30.
 *  - `notify_dependents`: blast_radius > 0 (message carries the dependent count and how many are direct).
 *  - `notify_service_owners`: at least one affected business service has criticality critical or high.
 *  - `rollback_plan`: change_type is configuration_change, version_upgrade, network_change, security_change or
 *    decommission, and risk_level is not minimal.
 *  - `verify_standby`: change_type is failover.
 *  - `clear_dependents_first`: change_type is decommission and blast_radius > 0.
 *  - `review_dependency_chain`: critical_path spans 3 or more hops.
 *  - `no_recorded_dependents`: blast_radius is 0. The graph is declared edges only, so this is not proof of none.
 */
export function deriveImpactRecommendations(
  impact: RecommendationInput,
  services: readonly Pick<AffectedBusinessService, 'business_criticality'>[]
): ImpactRecommendation[] {
  const out: ImpactRecommendation[] = [];
  const add = (id: string, message: string) => out.push({ id, message });
  const direct = impact.affected_cis.filter(ci => ci.hop_count === 1).length;
  const critical = services.filter(s => s.business_criticality === 'critical' || s.business_criticality === 'high').length;

  if (impact.risk_level === 'critical' || impact.risk_level === 'high'
      || (impact.estimated_downtime_minutes ?? 0) >= MAINTENANCE_WINDOW_DOWNTIME_MINUTES) {
    add('maintenance_window', 'Schedule this change in an approved maintenance window.');
  }
  if (impact.blast_radius > 0) {
    add('notify_dependents', `Notify the owners of the ${impact.blast_radius} dependent CIs (${direct} direct) before starting.`);
  }
  if (critical > 0) {
    add('notify_service_owners', `Notify the owners of the ${critical} critical or high-criticality business services affected.`);
  }
  if (ROLLBACK_CHANGE_TYPES.has(impact.change_type) && impact.risk_level !== 'minimal') {
    add('rollback_plan', 'Prepare and test a rollback plan before starting.');
  }
  if (impact.change_type === 'failover') {
    add('verify_standby', 'Confirm the standby target is healthy and in sync before failing over.');
  }
  if (impact.change_type === 'decommission' && impact.blast_radius > 0) {
    add('clear_dependents_first', 'Migrate or retire the dependent CIs before decommissioning.');
  }
  if (impact.critical_path.length - 1 >= LONG_CHAIN_HOPS) {
    add('review_dependency_chain', `The longest dependency chain is ${impact.critical_path.length - 1} hops; review each hop.`);
  }
  if (impact.blast_radius === 0) {
    add('no_recorded_dependents', 'No dependents are recorded in the declared graph. That is not proof that none exist.');
  }
  return out;
}
