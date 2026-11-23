// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Estate health, tenant-wide drift count and configuration coverage for the estate KPI payload of
 * GET /analytics/dashboard (HAP-1923: BW1 and BW4; HAP-1925: BW5 and BW6). All are caller-organization only and
 * additive; each degrades independently to `null` plus an `unavailable` entry (the dashboard.service convention)
 * instead of failing the dashboard or inventing a number.
 *
 * ## BW1/BW4: `health_score` and `ci_health`
 * Per-CI health is defined in services/ci-health.ts (open incidents of the caller's organization). `ci_health` counts
 * the organization's CIs per state; `health_score` is `healthy / total * 100`, one decimal. Both are null when the
 * ITIL tables are absent or more than OPEN_INCIDENT_MAX_CIS CIs have an open incident; `health_score` is also null
 * for an organization with no CIs. A null `health_score` is named in `unavailable`.
 *
 * ## BW5: `open_drift_count`
 * Drift evidence is `drift_detection_results`, one row per detection run (written by ConfigurationDriftDetector,
 * stamped with `organization_id` and the CI's `ci_incarnation_id`). There is no status column, so "open" is derived:
 * a CI is open-drifted when the LATEST detection of its CURRENT incarnation in the caller's organization has
 * `has_drift = true`. A later clean run closes it. Rows of another organization, of a replaced incarnation (the CI
 * was deleted and recreated), of a CI that no longer exists, or with no incarnation are never counted. The count is
 * of CIs, not of detection rows.
 *
 * ## BW6: `configuration_coverage`
 * coverage = (CIs that have BOTH an owner AND a discovery source) / (all CIs), all within the caller's organization.
 * - owner: the BW2 normalized `owner` (services/ci-normalized-fields.ts): the stored top-level `owner` property, else
 *   the first usable owner key of the CI's `metadata`. Counted only when it is a non-empty string after trimming.
 * - discovery source: at least one `ci_source_lineage` row in the caller's organization for the CI, i.e. a source
 *   system has reported it (the same notion as the impact envelope's `unreported_ci_ids`). A CI created by hand has
 *   none. Lineage is matched on organization and `ci_id` (lineage rows carry no incarnation).
 * - `ratio` is `with_owner_and_source / total`, `null` when `total` is 0 (never 0 or NaN).
 *
 * ## BW7: `kpi_history` and `kpi_delta`
 * Four figures are snapshotted once per UTC day into `public.estate_kpi_snapshots` (migration 056): `health_score`,
 * `open_drift_count`, `configuration_coverage_ratio` and `total_cis`. The writer is the dashboard read itself
 * (`recordEstateKpiSnapshot`, `INSERT ... ON CONFLICT DO NOTHING`): the first snapshot of a day is the day's value and is
 * never rewritten, and a figure that is null (unavailable) is not recorded, never written as 0. There is no scheduler, so
 * a day on which nobody read the dashboard has no point: the series is the dates actually recorded (sparse), never a
 * filled calendar, and a delta compares the two newest RECORDED days however far apart they are.
 * `readEstateKpiHistory` returns up to the newest 10 recorded points per metric, ascending by date, and the delta
 * (latest minus the previous recorded value, null with fewer than 2 points).
 * Tenancy: every statement carries `WHERE organization_id = $1` AND runs in a transaction whose transaction-local
 * `cmdb.organization_id` setting satisfies the table's row level security policy (`withOrganizationScope`). The
 * organization is the verified caller's only; a missing setting matches no row. RLS is defence in depth: the setting is
 * settable by any session, so it is not a sole control.
 */

import neo4j, { type Session } from 'neo4j-driver';
import type { PostgresClient } from '@cmdb/database';
import { ciIncarnationId, logger } from '@cmdb/common';
import { projectCIFields } from './ci-normalized-fields';
import { healthFromTopPriority, readOpenIncidentPriorities } from './ci-health';

/** More distinct open-drifted CIs than this and the count is unavailable rather than partial. */
export const OPEN_DRIFT_MAX_CIS = 5_000;
/** An organization with more CIs than this has no coverage figure rather than a partial one. */
export const COVERAGE_SCAN_MAX_CIS = 20_000;
/** More distinct CIs with an open incident than this and the health figures are unavailable rather than partial. */
export const OPEN_INCIDENT_MAX_CIS = 5_000;
const GRAPH_TIMEOUT_MS = 5_000;

export interface ConfigurationCoverage {
  with_owner_and_source: number;
  total: number;
  ratio: number | null;
}

/** Estate CI counts by derived health state (services/ci-health.ts); the three states add up to `total`. */
export interface EstateHealth {
  healthy: number;
  degraded: number;
  critical: number;
  total: number;
}

export interface EstateKpis {
  /** Percentage (0 to 100, one decimal) of the organization's CIs that are `healthy`; null when unavailable. */
  health_score: number | null;
  ci_health: EstateHealth | null;
  open_drift_count: number | null;
  configuration_coverage: ConfigurationCoverage | null;
  /** Names of the fields above that are null because they could not be computed. */
  unavailable: string[];
}

type Graph = Pick<Session, 'run'>;
type Sql = Pick<PostgresClient, 'query'>;
/** The history needs a dedicated connection for its organization-scoped transaction. */
type HistorySql = Pick<PostgresClient, 'getClient'>;
type HistoryClient = Awaited<ReturnType<PostgresClient['getClient']>>;

/** The figure cannot be computed (bound exceeded or no backing data); it is reported as unavailable, not as an error. */
class EstateKpiUnavailableError extends Error {}

/** Latest detection per (CI, incarnation) in the organization, keeping only those that still show drift. */
const OPEN_DRIFT_SQL = `
  SELECT latest.ci_id, latest.ci_incarnation_id
  FROM (
    SELECT DISTINCT ON (d.ci_id, d.ci_incarnation_id) d.ci_id, d.ci_incarnation_id, d.has_drift
    FROM drift_detection_results d
    WHERE d.organization_id = $1::uuid AND d.ci_incarnation_id IS NOT NULL
    ORDER BY d.ci_id, d.ci_incarnation_id, d.detected_at DESC, d.created_at DESC, d.id DESC
  ) latest
  WHERE latest.has_drift
  LIMIT $2`;

async function openDriftCount(graph: Graph, sql: Sql, organizationId: string): Promise<number> {
  const drifted = await sql.query(OPEN_DRIFT_SQL, [organizationId, OPEN_DRIFT_MAX_CIS + 1]);
  if (drifted.rows.length > OPEN_DRIFT_MAX_CIS) throw new EstateKpiUnavailableError();
  if (drifted.rows.length === 0) return 0;
  // Only CIs that still exist in the caller's organization, at the incarnation the detection ran against.
  const current = await graph.run(`
    MATCH (ci:CI)
    WHERE ci.organization_id = $organizationId AND ci.id IN $ciIds
    RETURN ci.id AS ciId, ci.incarnation_id AS incarnationId
  `, { organizationId, ciIds: drifted.rows.map((row: { ci_id: string }) => row.ci_id) }, { timeout: GRAPH_TIMEOUT_MS });
  const incarnations = new Map<string, string | null>(
    current.records.map(record => [record.get('ciId') as string, ciIncarnationId(record.get('incarnationId') as string | null)]));
  return drifted.rows.filter((row: { ci_id: string; ci_incarnation_id: string }) =>
    incarnations.get(row.ci_id)?.toLowerCase() === String(row.ci_incarnation_id).toLowerCase()).length;
}

/**
 * BW1/BW4: CIs of the caller's organization by health state. `totalCis` is the organization's CI count. An open
 * incident whose `affected_ci_id` is not a CI of the caller's organization (deleted, never existed, another
 * tenant's id) is not counted.
 */
async function estateHealth(graph: Graph, sql: Sql, organizationId: string, totalCis: number): Promise<EstateHealth> {
  const open = await readOpenIncidentPriorities(sql, organizationId, null, OPEN_INCIDENT_MAX_CIS);
  if (open === null) throw new EstateKpiUnavailableError();
  if (open.size > OPEN_INCIDENT_MAX_CIS) throw new EstateKpiUnavailableError();
  let critical = 0;
  let degraded = 0;
  if (open.size > 0) {
    const existing = await graph.run(`
      MATCH (ci:CI)
      WHERE ci.organization_id = $organizationId AND ci.id IN $ciIds
      RETURN ci.id AS ciId
    `, { organizationId, ciIds: [...open.keys()] }, { timeout: GRAPH_TIMEOUT_MS });
    for (const record of existing.records) {
      if (healthFromTopPriority(open.get(record.get('ciId') as string)!) === 'critical') critical++;
      else degraded++;
    }
  }
  return { healthy: Math.max(0, totalCis - critical - degraded), degraded, critical, total: totalCis };
}

async function configurationCoverage(graph: Graph, sql: Sql, organizationId: string): Promise<ConfigurationCoverage> {
  // The node's own `owner` wins; `metadata` is only needed when it is absent (see projectCIFields).
  const scan = await graph.run(`
    MATCH (ci:CI)
    WHERE ci.organization_id = $organizationId
    RETURN ci.id AS ciId, ci.owner AS owner, CASE WHEN ci.owner IS NULL THEN ci.metadata END AS metadata
    LIMIT $rowLimit
  `, { organizationId, rowLimit: neo4j.int(COVERAGE_SCAN_MAX_CIS + 1) }, { timeout: GRAPH_TIMEOUT_MS });
  if (scan.records.length > COVERAGE_SCAN_MAX_CIS) throw new EstateKpiUnavailableError();

  const owned: string[] = [];
  for (const record of scan.records) {
    const { owner } = projectCIFields({ owner: record.get('owner'), metadata: record.get('metadata') });
    if (typeof owner === 'string' && owner.trim().length > 0) owned.push(record.get('ciId') as string);
  }
  const total = scan.records.length;
  let withOwnerAndSource = 0;
  if (owned.length > 0) {
    const sourced = await sql.query(
      `SELECT count(DISTINCT l.ci_id)::int AS with_source
       FROM ci_source_lineage l
       WHERE l.organization_id = $1::uuid AND l.ci_id = ANY($2::text[])`,
      [organizationId, owned]);
    withOwnerAndSource = Number(sourced.rows[0]?.with_source ?? 0);
  }
  return { with_owner_and_source: withOwnerAndSource, total, ratio: total === 0 ? null : withOwnerAndSource / total };
}

export async function readEstateKpis(
  graph: Graph, sql: Sql, organizationId: string, totalCis: number,
): Promise<EstateKpis> {
  const unavailable: string[] = [];
  const attempt = async <T>(field: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof EstateKpiUnavailableError)) logger.warn(`Estate KPI ${field} unavailable`, error);
      unavailable.push(field);
      return null;
    }
  };
  const ci_health = await attempt('health_score', () => estateHealth(graph, sql, organizationId, totalCis));
  const health_score = ci_health === null || ci_health.total === 0
    ? null : Math.round((ci_health.healthy / ci_health.total) * 1000) / 10;
  if (ci_health !== null && health_score === null) unavailable.push('health_score');
  const open_drift_count = await attempt('open_drift_count', () => openDriftCount(graph, sql, organizationId));
  const configuration_coverage = await attempt('configuration_coverage', () => configurationCoverage(graph, sql, organizationId));
  return { health_score, ci_health, open_drift_count, configuration_coverage, unavailable };
}

// ---------------------------------------------------------------------------------------------------------------------
// BW7: daily snapshots, sparkline series and deltas
// ---------------------------------------------------------------------------------------------------------------------

/** The closed metric list of estate_kpi_snapshots.metric (CHECK in migration 056). */
export const KPI_HISTORY_METRICS = ['health_score', 'open_drift_count', 'configuration_coverage_ratio', 'total_cis'] as const;
export type KpiHistoryMetric = (typeof KPI_HISTORY_METRICS)[number];
/** Newest recorded points returned per metric. */
export const KPI_HISTORY_POINTS = 10;

export interface KpiHistoryPoint {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  value: number;
}
export type KpiHistory = Record<KpiHistoryMetric, KpiHistoryPoint[]>;
export type KpiDelta = Record<KpiHistoryMetric, number | null>;

/**
 * Runs `work` in a transaction on its own connection with the transaction-local `cmdb.organization_id` set, the key of
 * the row level security policy of estate_kpi_snapshots. The connection is always released (evicted when the rollback
 * itself failed). `organizationId` must be the verified caller's.
 */
async function withOrganizationScope<T>(
  pg: HistorySql, organizationId: string, work: (client: HistoryClient) => Promise<T>,
): Promise<T> {
  const client = await pg.getClient();
  let broken = false;
  try {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('cmdb.organization_id', $1, true)", [organizationId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw error;
    }
  } finally {
    client.release(broken ? true : undefined);
  }
}

/** The figures that are recorded: only non-null, finite, non-negative ones (a null is unknown, never 0). */
function snapshotFigures(kpis: EstateKpis, totalCis: number): Array<[KpiHistoryMetric, number]> {
  const figures: Array<[KpiHistoryMetric, number | null]> = [
    ['health_score', kpis.health_score],
    ['open_drift_count', kpis.open_drift_count],
    ['configuration_coverage_ratio', kpis.configuration_coverage?.ratio ?? null],
    ['total_cis', totalCis],
  ];
  return figures.filter((figure): figure is [KpiHistoryMetric, number] =>
    figure[1] !== null && Number.isFinite(figure[1]) && figure[1] >= 0);
}

/**
 * Records today's (UTC) value of each available figure for the organization. The first write of a UTC day wins
 * (ON CONFLICT DO NOTHING): later reads the same day change nothing. Returns when the transaction committed.
 */
export async function recordEstateKpiSnapshot(
  sql: HistorySql, organizationId: string, kpis: EstateKpis, totalCis: number,
): Promise<void> {
  const figures = snapshotFigures(kpis, totalCis);
  if (figures.length === 0) {
    return;
  }
  const snapshotDate = new Date().toISOString().slice(0, 10);
  await withOrganizationScope(sql, organizationId, client => client.query(
    `INSERT INTO public.estate_kpi_snapshots (organization_id, snapshot_date, metric, value)
     SELECT $1::uuid, $2::date, f.metric, f.value FROM unnest($3::text[], $4::numeric[]) AS f(metric, value)
     ON CONFLICT (organization_id, snapshot_date, metric) DO NOTHING`,
    [organizationId, snapshotDate, figures.map(([metric]) => metric), figures.map(([, value]) => value)]));
}

/** Newest KPI_HISTORY_POINTS recorded rows per metric of the organization. */
const HISTORY_SQL = `
  SELECT to_char(s.snapshot_date, 'YYYY-MM-DD') AS date, s.metric, s.value::float8 AS value
  FROM (
    SELECT snapshot_date, metric, value,
           row_number() OVER (PARTITION BY metric ORDER BY snapshot_date DESC) AS recency
    FROM public.estate_kpi_snapshots
    WHERE organization_id = $1::uuid
  ) s
  WHERE s.recency <= $2
  ORDER BY s.metric, s.snapshot_date`;

/** Float noise (87.5 - 87.3) is not a delta: round to 10 decimals. */
const roundDelta = (delta: number): number => Math.round(delta * 1e10) / 1e10;

/**
 * Up to KPI_HISTORY_POINTS recorded points per metric, ascending by date (a metric with none is `[]`), and the delta of
 * each metric: latest recorded value minus the previous recorded value, null with fewer than 2 points.
 */
export async function readEstateKpiHistory(
  sql: HistorySql, organizationId: string,
): Promise<{ kpi_history: KpiHistory; kpi_delta: KpiDelta }> {
  const result = await withOrganizationScope(sql, organizationId, client =>
    client.query(HISTORY_SQL, [organizationId, KPI_HISTORY_POINTS]));
  const kpi_history = Object.fromEntries(KPI_HISTORY_METRICS.map(metric => [metric, [] as KpiHistoryPoint[]])) as KpiHistory;
  for (const row of result.rows as Array<{ date: string; metric: KpiHistoryMetric; value: number }>) {
    kpi_history[row.metric]?.push({ date: row.date, value: Number(row.value) });
  }
  const kpi_delta = Object.fromEntries(KPI_HISTORY_METRICS.map(metric => {
    const points = kpi_history[metric];
    return [metric, points.length < 2 ? null : roundDelta(points[points.length - 1].value - points[points.length - 2].value)];
  })) as KpiDelta;
  return { kpi_history, kpi_delta };
}
