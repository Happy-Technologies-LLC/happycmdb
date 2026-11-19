// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1926 (UX-4b BW10): availability over the last 24 hours for the estate hub's "Top services" list,
 * `GET /business-services/availability`.
 *
 * ## Signal source (decision): incident-derived, not probed
 * The repository stores no uptime probe or monitoring signal for a service. What it does record is incidents
 * (`itil_incidents`: `reported_at`, `resolved_at`/`closed_at`, `priority`) and the CIs a service is mapped to
 * (`ci_business_service_mappings`). The figure is therefore DERIVED, by this rule:
 * - A service-affecting incident is one of the caller's organization with priority 1 or 2 (P1/P2) whose status is not
 *   `cancelled` and whose `affected_ci_id` is mapped to the service. Lower priorities are not outages.
 * - Its downtime interval is `[reported_at, resolved_at]`, else `closed_at`, else (status `resolved`/`closed` with neither
 *   timestamp recorded) `updated_at`, else still open (up to now), clipped to the window `[now() - 24 h, now()]` on the
 *   database clock. A finished incident missing both timestamps therefore never counts as down until now.
 * - Overlapping intervals of one service are merged, so two simultaneous incidents count their union once.
 * - `availability_24h_pct = 100 * (1 - downtime / 24 h)`, rounded to 3 decimals; `downtime_minutes_24h` is the merged
 *   downtime rounded to 2 decimals; `service_affecting_incidents_24h` counts the distinct incidents with downtime in
 *   the window.
 * A service with no CI mapped has no signal path: all three figures are `null` and listed in its `unavailable`. A mapped
 * service with no service-affecting incident in the window reads 100 %: that means "no P1/P2 incident recorded", it is
 * NOT a probe-verified uptime. The payload states this as `basis: "incident_derived"`.
 *
 * ## Which services
 * The caller's organization's services in lifecycle `live` or `retiring`, most critical first (critical, high, medium,
 * low, other), then name, then service id; `limit` 1..50 (default 5).
 */

/*
 * Known limits. `has_mapped_cis` counts mappings (`ci_business_service_mappings`) to CIs that no longer exist in the
 * graph: a service whose only CIs were deleted still reads 100 % (no P1/P2 incident recorded), not `null`. The read
 * cannot tell, because it never consults Neo4j.
 *
 * Unavailable schema: where `itil_incidents` has no `organization_id` (or does not exist: V2/V3 schemas), no signal
 * path exists, so every listed service reads like an unmapped one (three `null` figures, all three names in
 * `unavailable`), never 100 %. The check is `itilRecordTablesAvailable`, the one CI health uses.
 *
 * Bounded: the controller runs every statement in one transaction under a PostgreSQL `statement_timeout`
 * (`ESTATE_FEED_TIMEOUT_MS`, default 5000 ms; services/bounded-pg-read.ts); a timeout answers 503, never a partial figure.
 */

import { itilRecordTablesAvailable } from './itil-record-schema';

/** The one pg method these reads need; both the pool and a pooled client satisfy it. */
interface Sql {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** When an incident stopped counting as down: resolved_at, else closed_at, else updated_at for a finished one, else now. */
const INCIDENT_END = `COALESCE(i.resolved_at, i.closed_at,
                CASE WHEN i.status IN ('resolved', 'closed') THEN i.updated_at ELSE now() END)`;

/**
 * `INCIDENT_END > cut`, written column by column: the first non-NULL of resolved_at, closed_at and the status arm is
 * the one compared, exactly as COALESCE picks it. A COALESCE over three columns is one opaque expression no index can
 * serve; this form lets the planner use a per-column index on each arm. `cut` is a SQL expression. Both forms select
 * the same rows (hap1926.estate-feeds.test.ts checks every NULL / status / cutoff combination against the COALESCE).
 */
export const incidentEndsAfter = (cut: string): string =>
  `(i.resolved_at > ${cut} OR (i.resolved_at IS NULL AND (i.closed_at > ${cut} OR (i.closed_at IS NULL AND ` +
  `(CASE WHEN i.status IN ('resolved', 'closed') THEN i.updated_at ELSE now() END) > ${cut}))))`;

export const AVAILABILITY_WINDOW_HOURS = 24;
export const AVAILABILITY_DEFAULT_LIMIT = 5;
export const AVAILABILITY_MAX_LIMIT = 50;
/** Incidents of this priority or more urgent (1 = most urgent) count as service-affecting. */
export const SERVICE_AFFECTING_MAX_PRIORITY = 2;
const WINDOW_MS = AVAILABILITY_WINDOW_HOURS * 3_600_000;

export interface ServiceAvailability {
  service_id: string;
  name: string;
  criticality: string;
  availability_24h_pct: number | null;
  downtime_minutes_24h: number | null;
  service_affecting_incidents_24h: number | null;
  /** Names of the figures above that are null because no data backs them. */
  unavailable: string[];
}

export interface AvailabilityReport {
  window_hours: typeof AVAILABILITY_WINDOW_HOURS;
  basis: 'incident_derived';
  services: ServiceAvailability[];
}

export type AvailabilityOptions = { limit: number } | { error: string };

/** Invalid values are rejected (400), not clamped. */
export function parseAvailabilityOptions(query: Record<string, unknown>): AvailabilityOptions {
  const raw = query['limit'];
  const limit = raw === undefined ? AVAILABILITY_DEFAULT_LIMIT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > AVAILABILITY_MAX_LIMIT) {
    return { error: `limit must be an integer from 1 to ${AVAILABILITY_MAX_LIMIT}` };
  }
  return { limit };
}

/** Milliseconds covered by the union of the intervals. */
export function mergedDowntimeMs(intervals: Array<{ start: number; end: number }>): number {
  const ordered = intervals.filter(({ start, end }) => end > start).sort((a, b) => a.start - b.start);
  let total = 0;
  let cursor = -Infinity;
  for (const { start, end } of ordered) {
    const from = Math.max(start, cursor);
    if (end > from) total += end - from;
    cursor = Math.max(cursor, end);
  }
  return total;
}

export async function readServiceAvailability(sql: Sql, organizationId: string, limit: number): Promise<AvailabilityReport> {
  const services = await sql.query(
    `SELECT s.service_id, s.name, s.business_criticality,
            EXISTS (SELECT 1 FROM ci_business_service_mappings m WHERE m.service_id = s.service_id) AS has_mapped_cis
     FROM dim_business_services s
     WHERE s.organization_id = $1 AND s.lifecycle IN ('live', 'retiring')
     ORDER BY CASE s.business_criticality WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
                WHEN 'low' THEN 3 ELSE 4 END, s.name, s.service_id
     LIMIT $2`,
    [organizationId, limit]);

  // Without the incident table there is no signal path for any service: same state as an unmapped one.
  const signal = await itilRecordTablesAvailable((text, params) => sql.query(text, params), 'itil_incidents');
  const mapped: string[] = !signal ? [] : services.rows.filter((row: { has_mapped_cis: boolean }) => row.has_mapped_cis)
    .map((row: { service_id: string }) => row.service_id);
  const byService = new Map<string, Array<{ id: string; start: number; end: number }>>();
  if (mapped.length > 0) {
    // DISTINCT: one incident reaches a service through every mapping_type row of the same CI.
    const incidents = await sql.query(
      `SELECT DISTINCT m.service_id, i.id,
              GREATEST(i.reported_at, now() - ($3::int * interval '1 hour')) AS start_at,
              LEAST(${INCIDENT_END}, now()) AS end_at
       FROM itil_incidents i
       JOIN ci_business_service_mappings m ON m.ci_id = i.affected_ci_id
       WHERE i.organization_id = $1 AND m.service_id = ANY($2::text[])
         AND i.priority <= $4 AND i.status <> 'cancelled'
         AND i.reported_at < now()
         AND ${incidentEndsAfter(`now() - ($3::int * interval '1 hour')`)}`,
      [organizationId, mapped, AVAILABILITY_WINDOW_HOURS, SERVICE_AFFECTING_MAX_PRIORITY]);
    for (const row of incidents.rows as Array<{ service_id: string; id: string; start_at: Date; end_at: Date }>) {
      const start = new Date(row.start_at).getTime();
      const end = new Date(row.end_at).getTime();
      if (!(end > start)) continue;
      const list = byService.get(row.service_id) ?? [];
      list.push({ id: row.id, start, end });
      byService.set(row.service_id, list);
    }
  }

  return {
    window_hours: AVAILABILITY_WINDOW_HOURS,
    basis: 'incident_derived',
    services: services.rows.map((row: Record<string, any>): ServiceAvailability => {
      const base = { service_id: row.service_id, name: row.name, criticality: row.business_criticality };
      if (!signal || !row.has_mapped_cis) {
        return { ...base, availability_24h_pct: null, downtime_minutes_24h: null, service_affecting_incidents_24h: null,
          unavailable: ['availability_24h_pct', 'downtime_minutes_24h', 'service_affecting_incidents_24h'] };
      }
      const intervals = byService.get(row.service_id) ?? [];
      const downtime = mergedDowntimeMs(intervals);
      return {
        ...base,
        availability_24h_pct: Math.round((1 - downtime / WINDOW_MS) * 100 * 1000) / 1000,
        downtime_minutes_24h: Math.round((downtime / 60_000) * 100) / 100,
        service_affecting_incidents_24h: new Set(intervals.map(interval => interval.id)).size,
        unavailable: [],
      };
    }),
  };
}
