// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared by the portfolio writes (business services, HAP-1423; service offerings, HAP-1424): If-Match versions, the
 * hash-chained audit row each accepted write appends, and the write-failure responses.
 */

import { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { appendAuditEntry } from '@cmdb/database';
import type { AuditChange, AuditEntityType } from '@cmdb/common';
import { requestActor } from '../../journal-http';

/** A refused portfolio write: nothing written, no audit row. */
export type WriteRefusal = { status: number; body: Record<string, unknown> };
export const WRITE_UNAVAILABLE = {
  success: false, error: 'Service Unavailable', message: 'Business service write temporarily unavailable',
};
/** Not listed in an audit row's changes: the row's organization_id column binds the org; timestamps are the row's. */
const UNAUDITED_COLUMNS: Record<string, true> = { organization_id: true, created_at: true, updated_at: true };

/**
 * If-Match as a record version: null when absent or `*`, undefined when malformed (400). Accepts the strong ETag
 * that POST and PATCH send (`"<version>"`, also the body's `version`) and bare digits; a weak tag (`W/"<n>"`) is
 * malformed, so 400, never a match.
 */
export function ifMatchVersion(header: string | undefined): number | null | undefined {
  if (header === undefined || header.trim() === '*') return null;
  const match = /^\s*(?:"([1-9][0-9]{0,9})"|([1-9][0-9]{0,9}))\s*$/.exec(header);
  return match ? Number(match[1] ?? match[2]) : undefined;
}

/**
 * One audit_log row on the write's own transaction, hash-chained by appendAuditEntry (C1 rule, F2: the portfolio's
 * local chain, no ledger event). Actor: the verified token subject (requestActor, HAP-443); changes: the columns whose
 * values differ between `before` and `after`. `extra` (HAP-1426: the import's import_id and defaulted fields) joins
 * the row's metadata; it never replaces `operation` or `version`.
 */
export async function appendPortfolioAudit(client: PoolClient, req: Request, organizationId: string,
  entity: { type: AuditEntityType; id: string },
  action: 'CREATE' | 'UPDATE' | 'DELETE', operation: 'create' | 'update' | 'retire' | 'delete' | 'import',
  before: Record<string, unknown> & { version: number } | null,
  after: Record<string, unknown> & { version: number } | null,
  extra: Record<string, unknown> = {}): Promise<void> {
  const row = (after ?? before)!;
  const changes: AuditChange[] = Object.keys(row).filter(field => UNAUDITED_COLUMNS[field] !== true).flatMap(field => {
    const old_value = before?.[field] ?? null;
    const new_value = after?.[field] ?? null;
    return JSON.stringify(old_value) === JSON.stringify(new_value) ? [] : [{ field, old_value, new_value }];
  });
  await appendAuditEntry(client, {
    entity_type: entity.type, entity_id: entity.id, action, actor: requestActor(req), actor_type: 'user',
    changes, metadata: { ...extra, operation, version: row.version },
  }, organizationId);
}

/** A chain-lock timeout (55P03) is a 503, as for journaled CI writes; anything else a generic 500 (detail in the log). */
export function sendWriteFailure(res: Response, error: unknown, message: string): void {
  if ((error as { code?: unknown } | null)?.code === '55P03') res.status(503).json(WRITE_UNAVAILABLE);
  else res.status(500).json({ success: false, error: message });
}
