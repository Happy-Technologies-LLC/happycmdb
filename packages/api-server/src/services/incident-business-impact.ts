// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1926 (UX-4b BW8): business impact of an incident and the open-incident ribbon payload.
 *
 * ## Where the figures come from (no migration, no invented number)
 * `itil_incidents.affected_business_service_id` is a UUID, but portfolio services (`dim_business_services`) are keyed
 * `bs-<uuid>`, so an incident can never carry one. The affected service is therefore derived from the affected CI:
 * the services in the caller's organization that `ci_business_service_mappings` maps the CI to (retired services
 * excluded). The figures are the ones an operator recorded on that service's `metadata` (the keys the business-service
 * UI and the portfolio seed already use):
 * - users affected  = `metadata.user_count`, when a positive finite number (rounded to a whole user);
 * - revenue per hour = `metadata.revenue_impact.annual_revenue_supported` / 8760, when a positive finite number
 *   (24x7 spread of the annual figure, rounded to cents). A plain-number `metadata.revenue_impact` has no unit and is
 *   ignored.
 * A service without such a figure, a CI mapped to no service, and a lookup failure all give `null`, never 0 and never a
 * placeholder estimate.
 *
 * ## Which service is "the" affected service
 * With several mapped services the primary one is the most critical (critical, high, medium, low, anything else), then
 * by name, then by service id. The figures are the primary service's alone: users overlap between services, so a sum
 * would overstate them. Every mapped service is listed in `business_impact.affected_services`.
 *
 * ## Stored vs. live
 * createIncident stores the figures in `business_impact`: `estimated_user_impact`, `revenue_per_hour` (a NEW key: the
 * rate) and `estimated_cost_of_downtime`; unknown = JSON null. `estimated_revenue_impact` is left null on create: other
 * writers (the ITIL priority service, seeds), GraphQL, the BI views and the web UI treat it as a TOTAL, so the ribbon
 * never reads it as a rate. The ribbon uses the stored figure when it is positive and otherwise derives it live from
 * the service metadata, so incidents created before this change (stored zeros, the column default, a total under
 * `estimated_revenue_impact`) and services documented later still show their figures. A stored users figure is rounded
 * to a whole user.
 *
 * ## The ribbon: `GET /itil/metrics/open-incidents`
 * Open = status not in resolved, closed, cancelled. Order: priority ascending (P1 first), then newest `reported_at`.
 * Every statement is scoped by `organization_id`; the service side is scoped by the service's own organization.
 */

/** The one pg method these reads need; both the pool and a pooled client satisfy it. */
export interface Sql {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** Hours in a year used to turn an annual revenue figure into a per-hour rate (24x7). */
export const HOURS_PER_YEAR = 8760;
/** Most open incidents one ribbon request returns. */
export const RIBBON_MAX_INCIDENTS = 50;
export const RIBBON_DEFAULT_INCIDENTS = 5;
/** Most mapped services listed in a stored `business_impact.affected_services`. */
export const AFFECTED_SERVICES_MAX = 20;

const CRITICALITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const rank = (criticality: string): number => CRITICALITY_RANK[criticality] ?? 4;

export interface MappedServiceRow {
  ci_id: string;
  service_id: string;
  name: string;
  business_criticality: string;
  metadata: unknown;
}

export interface AffectedService {
  service_id: string;
  name: string;
}

export interface ServiceFigures {
  users_affected: number | null;
  revenue_per_hour: number | null;
}

export interface DerivedImpact extends ServiceFigures {
  primary: AffectedService | null;
  services: AffectedService[];
}

const positive = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The figures an operator recorded on one service's metadata (see the module comment). */
export function serviceFigures(metadata: unknown): ServiceFigures {
  const meta = isRecord(metadata) ? metadata : {};
  const users = positive(meta['user_count']);
  const revenue = isRecord(meta['revenue_impact']) ? positive(meta['revenue_impact']['annual_revenue_supported']) : null;
  return {
    users_affected: users === null ? null : Math.round(users),
    revenue_per_hour: revenue === null ? null : Math.round((revenue / HOURS_PER_YEAR) * 100) / 100,
  };
}

/** The mapped services of one CI, primary first (most critical, then name, then id). */
export function deriveImpact(rows: MappedServiceRow[]): DerivedImpact {
  const ordered = [...rows].sort((a, b) =>
    rank(a.business_criticality) - rank(b.business_criticality)
    || a.name.localeCompare(b.name) || a.service_id.localeCompare(b.service_id));
  const unique = ordered.filter((row, index) => ordered.findIndex(other => other.service_id === row.service_id) === index);
  const services = unique.map(({ service_id, name }) => ({ service_id, name }));
  const primary = unique[0];
  return {
    primary: services[0] ?? null,
    services,
    ...(primary ? serviceFigures(primary.metadata) : { users_affected: null, revenue_per_hour: null }),
  };
}

/** Services in the organization that the given CIs are mapped to; retired services never count. */
export async function readMappedServices(sql: Sql, organizationId: string, ciIds: string[]): Promise<MappedServiceRow[]> {
  if (ciIds.length === 0) return [];
  const result = await sql.query(
    `SELECT m.ci_id, s.service_id, s.name, s.business_criticality, s.metadata
     FROM ci_business_service_mappings m
     JOIN dim_business_services s ON s.service_id = m.service_id
     WHERE s.organization_id = $1 AND m.ci_id = ANY($2::text[]) AND s.lifecycle <> 'retired'`,
    [organizationId, ciIds]);
  return result.rows as MappedServiceRow[];
}

/** The `business_impact` JSON stored on a new incident; unknown figures are null (never the column's zero default). */
export function businessImpactFor(impact: DerivedImpact): Record<string, unknown> {
  return {
    estimated_user_impact: impact.users_affected,
    // The rate, under its own key: `estimated_revenue_impact` is a total for every other consumer and stays unset.
    estimated_revenue_impact: null,
    revenue_per_hour: impact.revenue_per_hour,
    estimated_cost_of_downtime: null,
    affected_services: impact.services.slice(0, AFFECTED_SERVICES_MAX),
  };
}

export interface RibbonIncident {
  id: string;
  incident_number: string;
  title: string;
  priority: number;
  status: string;
  affected_ci_id: string | null;
  affected_service: AffectedService | null;
  opened_at: string;
  users_affected: number | null;
  revenue_per_hour: number | null;
  /** Names of the fields above that are null because no data backs them. */
  unavailable: string[];
}

export interface OpenIncidentRibbon {
  incidents: RibbonIncident[];
  /** Every open incident of the organization, not only the ones returned. */
  open_count: number;
}

const stored = (businessImpact: unknown, key: string): number | null =>
  isRecord(businessImpact) ? positive(Number(businessImpact[key])) : null;

const storedUsers = (businessImpact: unknown): number | null => {
  const users = stored(businessImpact, 'estimated_user_impact');
  return users === null ? null : positive(Math.round(users));
};

export async function readOpenIncidentRibbon(
  sql: Sql, organizationId: string, limit: number
): Promise<OpenIncidentRibbon> {
  const open = `organization_id = $1 AND status NOT IN ('resolved', 'closed', 'cancelled')`;
  const [page, count] = await Promise.all([
    sql.query(
      `SELECT id, incident_number, title, priority, status, affected_ci_id, reported_at, business_impact
       FROM itil_incidents WHERE ${open}
       ORDER BY priority ASC, reported_at DESC, id LIMIT $2`,
      [organizationId, limit]),
    sql.query(`SELECT count(*)::int AS open_count FROM itil_incidents WHERE ${open}`, [organizationId]),
  ]);
  const ciIds = [...new Set(page.rows.map((row: { affected_ci_id: string | null }) => row.affected_ci_id)
    .filter((id: string | null): id is string => typeof id === 'string'))];
  const mapped = await readMappedServices(sql, organizationId, ciIds);
  const incidents = page.rows.map((row: Record<string, any>): RibbonIncident => {
    const live = deriveImpact(mapped.filter(service => service.ci_id === row.affected_ci_id));
    const users = storedUsers(row.business_impact) ?? live.users_affected;
    const revenue = stored(row.business_impact, 'revenue_per_hour') ?? live.revenue_per_hour;
    const unavailable = [
      ...(users === null ? ['users_affected'] : []),
      ...(revenue === null ? ['revenue_per_hour'] : []),
    ];
    return {
      id: row.id,
      incident_number: row.incident_number,
      title: row.title,
      priority: row.priority,
      status: row.status,
      affected_ci_id: row.affected_ci_id ?? null,
      affected_service: live.primary,
      opened_at: new Date(row.reported_at).toISOString(),
      users_affected: users,
      revenue_per_hour: revenue,
      unavailable,
    };
  });
  return { incidents, open_count: Number(count.rows[0]?.open_count ?? 0) };
}
