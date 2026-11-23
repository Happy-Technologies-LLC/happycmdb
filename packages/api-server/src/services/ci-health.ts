// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * CI health state (HAP-1923 BW1), derived at read time from the caller organization's OPEN incidents. Nothing is
 * stored.
 *
 * ## Definition
 * A CI is `critical` when it has an open incident of priority 1 or 2, `degraded` when its most severe open incident
 * is priority 3 to 5, and `healthy` when it has no open incident. An incident is open while its status is not
 * `resolved`, `closed` or `cancelled` (the dashboard's definition). Incidents attach to a CI through
 * `affected_ci_id` and are matched on the caller's `organization_id` only; a row of another organization, or with no
 * organization, never counts.
 *
 * ## Signals not used
 * Anomalies and health-metric rows carry only a `ci_id`, with no tenant or incarnation provenance, so they cannot be
 * attributed to an organization after an id is reused (GET /analytics/health-metrics/:ciId answers 403 for the same
 * reason). Drift is a configuration signal, not a health one. Both stay out of this definition until they can be
 * attributed.
 *
 * Incidents carry no CI incarnation (`itil_incidents` has no `ci_incarnation_id`), so an open incident follows the CI
 * id: when a CI is deleted and re-created under the same id in the same organization, the open incident marks the new
 * incarnation `critical` or `degraded` until it is resolved. The effect stays inside one tenant (every read is scoped by
 * `organization_id`); it is a known limit of the signal, not something a read can correct.
 *
 * ## Unavailable, never faked
 * Where the ITIL record tables are absent (V2/V3 schemas), no health signal exists: every figure is `null`, not
 * `healthy`. A read that fails after the tables are known to exist throws for the caller to handle.
 *
 * ## Bounded
 * `withCIHealth` runs the read in one transaction under a PostgreSQL `statement_timeout` (`CI_HEALTH_TIMEOUT_MS`,
 * default 3000 ms; services/bounded-pg-read.ts). A stalled or locked database therefore fails the read with SQLSTATE
 * `57014`, and the CI read answers `health: null` instead of waiting on it.
 */

import { boundedPgRead, ciHealthTimeoutMs, type TransactionalSql } from './bounded-pg-read';
import { itilRecordTablesAvailable } from './itil-record-schema';

export type CIHealthState = 'healthy' | 'degraded' | 'critical';

/** Incident priorities at or below this make the CI `critical` (1 = most severe). */
export const CRITICAL_INCIDENT_MAX_PRIORITY = 2;
/** Incident statuses that no longer count; the same list the ITSM dashboard uses. */
export const CLOSED_INCIDENT_STATUSES: readonly string[] = Object.freeze(['resolved', 'closed', 'cancelled']);

type Sql = { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> };

/** The health state of a CI whose most severe open incident has this priority. */
export function healthFromTopPriority(priority: number): Exclude<CIHealthState, 'healthy'> {
  return priority <= CRITICAL_INCIDENT_MAX_PRIORITY ? 'critical' : 'degraded';
}

/**
 * Most severe open-incident priority per CI, in `organizationId`. `ciIds` null means every CI with an open incident,
 * at most `limit + 1` rows (the caller treats `limit + 1` rows as over the bound). Null when the ITIL tables do not exist.
 */
export async function readOpenIncidentPriorities(
  sql: Sql, organizationId: string, ciIds: readonly string[] | null, limit = ciIds?.length ?? 0,
): Promise<Map<string, number> | null> {
  if (!await itilRecordTablesAvailable((text, params) => sql.query(text, params), 'itil_incidents')) return null;
  if (ciIds !== null && ciIds.length === 0) return new Map();
  const result = await sql.query(
    `SELECT affected_ci_id, min(priority)::int AS top_priority
       FROM itil_incidents
      WHERE organization_id = $1
        AND affected_ci_id IS NOT NULL AND affected_ci_id <> ''
        AND ($2::text[] IS NULL OR affected_ci_id = ANY($2::text[]))
        AND status <> ALL($3::text[])
      GROUP BY affected_ci_id
      ORDER BY affected_ci_id
      LIMIT $4`,
    [organizationId, ciIds === null ? null : [...ciIds], [...CLOSED_INCIDENT_STATUSES], limit + 1]);
  return new Map(result.rows.map((row: { affected_ci_id: string; top_priority: number }) =>
    [row.affected_ci_id, Number(row.top_priority)]));
}

/**
 * Health state per CI id for the caller's organization; every id asked about is present (`healthy` with no open
 * incident). Null when the health signal is unavailable. Unbounded: `withCIHealth` supplies the bound.
 */
export async function readCIHealth(
  sql: Sql, organizationId: string, ciIds: readonly string[],
): Promise<Map<string, CIHealthState> | null> {
  const open = await readOpenIncidentPriorities(sql, organizationId, ciIds);
  if (open === null) return null;
  return new Map(ciIds.map(id => {
    const priority = open.get(id);
    return [id, priority === undefined ? 'healthy' : healthFromTopPriority(priority)] as const;
  }));
}

/**
 * The CIs with a `health` key: the derived state, or `null` when the signal is unavailable (or the read failed or
 * timed out, which must not fail the CI read itself). Every other key is unchanged. `onError` is called once per
 * failed read.
 */
export async function withCIHealth<T extends { id: string }>(
  pg: TransactionalSql, organizationId: string, cis: readonly T[], onError: (error: unknown) => void,
): Promise<Array<T & { health: CIHealthState | null }>> {
  let health: Map<string, CIHealthState> | null = null;
  try {
    const ciIds = cis.map(ci => ci.id);
    health = await boundedPgRead(pg, ciHealthTimeoutMs(), sql => readCIHealth(sql, organizationId, ciIds));
  } catch (error) {
    onError(error);
  }
  return cis.map(ci => ({ ...ci, health: health?.get(ci.id) ?? null }));
}
