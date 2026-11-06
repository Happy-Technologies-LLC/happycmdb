// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1608 D(1): the only SQL on ai_sync_cursors (migration 047). Tenancy is application-level, as for every cmdb
 * table: each statement is keyed by the primary key (organization_id, stream), so one organization's sync can neither
 * read nor advance another's cursor. Whether cmdb adds row-level security is an open operator decision (no RLS here).
 */

/** The streams migration 047's CHECK admits. */
export type AISyncCursorStream = 'c4_releases' | 'c6_receipts' | 'c8_cells' | 'c8_admissions' | 'c9_definitions';

export interface AISyncCursor {
  cursor: string | null;
  asOf: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
}

export class AISyncCursors {
  /** A pg Pool or client: app-login connections hold SELECT, INSERT, UPDATE on the table (047). */
  constructor(private readonly db: { query(text: string, params: unknown[]): Promise<{ rows: AISyncCursor[] }> }) {}

  /** This organization's cursor for the stream; null before its first successful sync. */
  async read(organizationId: string, stream: AISyncCursorStream): Promise<AISyncCursor | null> {
    const { rows } = await this.db.query(`SELECT cursor, as_of AS "asOf", last_success_at AS "lastSuccessAt",
        last_error_code AS "lastErrorCode"
      FROM ai_sync_cursors WHERE organization_id = $1 AND stream = $2`, [organizationId, stream]);
    return rows[0] ?? null;
  }

  /**
   * Records a successful sync up to `cursor` (source time `asOf`) for this organization only, with the run's soft
   * error code (null clears it). HAP-1444: a run that read an older snapshot than the stored one changes nothing.
   */
  async advance(organizationId: string, stream: AISyncCursorStream, cursor: string, asOf: Date,
    lastErrorCode: string | null = null): Promise<void> {
    if (lastErrorCode !== null) errorCode(lastErrorCode);
    await this.db.query(`INSERT INTO ai_sync_cursors (organization_id, stream, cursor, as_of, last_success_at, last_error_code, updated_at)
      VALUES ($1, $2, $3, $4, now(), $5, now())
      ON CONFLICT (organization_id, stream) DO UPDATE SET cursor = EXCLUDED.cursor, as_of = EXCLUDED.as_of,
        last_success_at = EXCLUDED.last_success_at, last_error_code = EXCLUDED.last_error_code, updated_at = EXCLUDED.updated_at
      WHERE ai_sync_cursors.as_of IS NULL OR EXCLUDED.as_of >= ai_sync_cursors.as_of`,
    [organizationId, stream, cursor, asOf, lastErrorCode]);
  }

  /** HAP-1444: records a failed run's error code for this organization; the cursor and its as-of stay as they were. */
  async recordError(organizationId: string, stream: AISyncCursorStream, code: string): Promise<void> {
    await this.db.query(`INSERT INTO ai_sync_cursors (organization_id, stream, last_error_code, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (organization_id, stream) DO UPDATE SET last_error_code = EXCLUDED.last_error_code,
        updated_at = EXCLUDED.updated_at`, [organizationId, stream, errorCode(code)]);
  }
}

/** A stored error code is a short machine code (never a message that could carry source data). */
function errorCode(code: string): string {
  if (!/^[a-z0-9_]{1,64}$/.test(code)) throw new Error('ai_sync_cursors: invalid error code');
  return code;
}
