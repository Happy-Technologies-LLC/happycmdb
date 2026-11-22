// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1926 (UX-4b BW9): tenant-wide recent CI changes feed, `GET /analytics/recent-changes`.
 *
 * Source: `ci_change_history`, the same table behind `/analytics/change-history` (one CI) and `/analytics/change-timeline`
 * (daily counts). A row is returned only when ALL hold:
 * - `organization_id` is the caller's organization (rows without one never match);
 * - it was recorded in the window `[now() - window, now()]` on the database clock (`1h` default, or `24h`);
 * - its CI still exists in the caller's organization at the incarnation the row was recorded against (the
 *   change-timeline fence): a CI that was deleted, or deleted and recreated under the same id, contributes no rows.
 * Newest first (`changed_at DESC`, then `id`); `limit` 1..100 (default 20). `total` counts every qualifying row in the
 * window, not only the page, so a UI can say "+N more".
 *
 * `ci_name` and `ci_type` come from the caller's organization's graph; either is `null` when the CI has no such
 * property. There is no push channel: the feed is a poll.
 */

import type { Session } from 'neo4j-driver';

/** The one pg method these reads need; both the pool and a pooled client satisfy it. */
interface Sql {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export const RECENT_CHANGES_WINDOWS = { '1h': 1, '24h': 24 } as const;
export type RecentChangesWindow = keyof typeof RECENT_CHANGES_WINDOWS;
export const RECENT_CHANGES_DEFAULT_LIMIT = 20;
export const RECENT_CHANGES_MAX_LIMIT = 100;
const GRAPH_TIMEOUT_MS = 5_000;

export interface RecentChange {
  id: string;
  changed_at: string;
  change_type: string;
  changed_by: string | null;
  change_source: string;
  changed_fields: string[];
  ci_id: string;
  ci_name: string | null;
  ci_type: string | null;
}

export interface RecentChanges {
  window: RecentChangesWindow;
  total: number;
  changes: RecentChange[];
}

export type RecentChangesOptions = { window: RecentChangesWindow; limit: number } | { error: string };

/** Invalid values are rejected (400), not clamped: a caller asking for 7d must not silently get 1h. */
export function parseRecentChangesOptions(query: Record<string, unknown>): RecentChangesOptions {
  const window = query['window'] ?? '1h';
  if (typeof window !== 'string' || !Object.hasOwn(RECENT_CHANGES_WINDOWS, window)) {
    return { error: 'window must be 1h or 24h' };
  }
  const raw = query['limit'];
  const limit = raw === undefined ? RECENT_CHANGES_DEFAULT_LIMIT : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > RECENT_CHANGES_MAX_LIMIT) {
    return { error: `limit must be an integer from 1 to ${RECENT_CHANGES_MAX_LIMIT}` };
  }
  return { window: window as RecentChangesWindow, limit };
}

interface ChangeRow {
  id: string;
  ci_id: string;
  change_type: string;
  changed_by: string | null;
  change_source: string;
  changed_fields: string[] | null;
  changed_at: Date | string;
  total: number | string;
}

export async function readRecentChanges(
  sql: Sql,
  session: Pick<Session, 'run'>,
  incarnations: Array<{ ciId: string; incarnationId: string }>,
  organizationId: string,
  options: { window: RecentChangesWindow; limit: number }
): Promise<RecentChanges> {
  if (incarnations.length === 0) {
    return { window: options.window, total: 0, changes: [] };
  }
  const result = await sql.query<ChangeRow>(
    `SELECT h.id, h.ci_id, h.change_type, h.changed_by, h.change_source, h.changed_fields, h.changed_at,
            count(*) OVER ()::int AS total
     FROM ci_change_history h
     JOIN jsonb_to_recordset($2::jsonb) AS current_ci("ciId" text, "incarnationId" uuid)
       ON h.ci_id = current_ci."ciId" AND h.ci_incarnation_id = current_ci."incarnationId"
     WHERE h.organization_id = $1::uuid
       AND h.changed_at >= now() - ($3::int * interval '1 hour') AND h.changed_at <= now()
     ORDER BY h.changed_at DESC, h.id
     LIMIT $4`,
    [organizationId, JSON.stringify(incarnations.map(({ ciId, incarnationId }) => ({ ciId, incarnationId }))),
      RECENT_CHANGES_WINDOWS[options.window], options.limit]);
  if (result.rows.length === 0) {
    return { window: options.window, total: 0, changes: [] };
  }

  const ciIds = [...new Set(result.rows.map(row => row.ci_id))];
  const described = await session.run(
    `MATCH (ci:CI) WHERE ci.organization_id = $organizationId AND ci.id IN $ciIds
     RETURN ci.id AS ciId, ci.name AS name, coalesce(ci.type, ci.ci_type) AS ciType`,
    { organizationId, ciIds }, { timeout: GRAPH_TIMEOUT_MS });
  const byId = new Map(described.records.map(record =>
    [record.get('ciId') as string, { name: record.get('name') as string | null, type: record.get('ciType') as string | null }]));
  const text = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;

  return {
    window: options.window,
    total: Number(result.rows[0].total),
    changes: result.rows.map((row): RecentChange => ({
      id: row.id,
      changed_at: new Date(row.changed_at).toISOString(),
      change_type: row.change_type,
      changed_by: row.changed_by ?? null,
      change_source: row.change_source,
      changed_fields: row.changed_fields ?? [],
      ci_id: row.ci_id,
      ci_name: text(byId.get(row.ci_id)?.name),
      ci_type: text(byId.get(row.ci_id)?.type),
    })),
  };
}
