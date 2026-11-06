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

  /** Records a successful sync up to `cursor` (source time `asOf`) for this organization only; clears the error. */
  async advance(organizationId: string, stream: AISyncCursorStream, cursor: string, asOf: Date): Promise<void> {
    await this.db.query(`INSERT INTO ai_sync_cursors (organization_id, stream, cursor, as_of, last_success_at, updated_at)
      VALUES ($1, $2, $3, $4, now(), now())
      ON CONFLICT (organization_id, stream) DO UPDATE SET cursor = EXCLUDED.cursor, as_of = EXCLUDED.as_of,
        last_success_at = EXCLUDED.last_success_at, last_error_code = NULL, updated_at = EXCLUDED.updated_at`,
    [organizationId, stream, cursor, asOf]);
  }
}
