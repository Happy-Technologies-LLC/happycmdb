// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { logger, type CI } from '@cmdb/common';

/**
 * The internal organization. Founder decision FD-4: CI data that carries no
 * organization belongs to it, as in PostgreSQL migrations 008 and 011 and the
 * Neo4j backfill 001_ci_organization_backfill.cypher.
 */
export const INTERNAL_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000000';

/** A CI read from its :CI node, with the node's organization_id property. */
export type ExtractedCI = CI & { organization_id?: unknown };

/**
 * cmdb.dim_ci.organization_id for a CI new to cmdb.dim_ci: its :CI node's
 * organization_id, or the internal organization when the node has none
 * (nodes written by discovery, connectors, ETL or reconciliation; FD-4).
 *
 * The value comes only from stored data, never from a request. PostgreSQL
 * returns a uuid in lower case, so the node's value is lower cased for
 * comparison with stored rows. A malformed value is passed through, so
 * PostgreSQL rejects the row (22P02) instead of it landing in some
 * organization.
 */
export function dimCiOrganizationId(nodeOrganizationId: unknown): string {
  if (nodeOrganizationId === null || nodeOrganizationId === undefined || nodeOrganizationId === '') {
    return INTERNAL_ORGANIZATION_ID;
  }
  return String(nodeOrganizationId).toLowerCase();
}

/** The organization of a CI already in cmdb.dim_ci, read from its current row. */
export interface StoredCiOrganization {
  organizationId: string;
  /**
   * org_backfilled: the internal label came from migration 011's backfill.
   * Rows written after 011 are FALSE.
   */
  backfilled: boolean;
}

/**
 * Whether a :CI node id can be its cmdb.dim_ci ci_id, stored and compared
 * exactly as Neo4j keeps it apart from every other id: a non-empty string of
 * at most 100 characters (ci_id VARCHAR(100)), without NUL and without an
 * unpaired surrogate. Otherwise two distinct node ids could name one ci_id
 * and one node could read, claim or write another CI's history:
 *  - Neo4j tells the number 12345 (a reconciliation merge can set one) from
 *    the string '12345'; node-postgres sends both as the text '12345';
 *  - VARCHAR(100) silently drops excess trailing spaces on insert, while the
 *    lock key and the current-row read still see them;
 *  - UTF-8 encoding turns any unpaired surrogate into U+FFFD.
 * PostgreSQL rejects NUL in text, which would fail a whole batch.
 */
export function isDimCiId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Array.from(value).length <= 100 &&
    !value.includes('\u0000') && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value);
}

/**
 * The extracted CIs whose node id passes isDimCiId. Other nodes are skipped
 * and logged before any lock or read.
 */
export function withDimCiIds<T>(cis: T[], id: (ci: T) => unknown, job: string): T[] {
  const valid = cis.filter(ci => isDimCiId(id(ci)));
  if (valid.length < cis.length) {
    logger.warn('Skipping CI nodes whose id cannot be a cmdb.dim_ci ci_id', { job, skipped: cis.length - valid.length });
  }
  return valid;
}

/** The ids that pass isDimCiId; the others are skipped and logged. */
export function dimCiIds(ids: unknown[], job: string): string[] {
  const valid = ids.filter(isDimCiId);
  if (valid.length < ids.length) {
    logger.warn('Skipping CI ids that cannot be a cmdb.dim_ci ci_id', { job, skipped: ids.length - valid.length });
  }
  return valid;
}

/** parseNodeMetadata's result for a metadata property that is not JSON. */
export const UNREADABLE_METADATA: unique symbol = Symbol('UNREADABLE_METADATA');

/**
 * A :CI node's metadata property (a JSON string) parsed; {} when absent.
 * Any writer, a reconciliation merge included, can store a string that is
 * not JSON there; the ETL then skips that one node instead of failing the run.
 */
export function parseNodeMetadata(raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') {
    return {};
  }
  try {
    return JSON.parse(String(raw));
  } catch {
    return UNREADABLE_METADATA;
  }
}

/** The SQLSTATE of a PostgreSQL error (pg sets `code`), or undefined. */
function sqlState(error: unknown): string | undefined {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/**
 * Whether a CI failed to load because of its own values: a PostgreSQL data
 * exception (SQLSTATE class 22: an overlong discovery field, metadata that is
 * not JSON, a malformed uuid) or integrity constraint violation (class 23).
 * Only such a CI is rolled back to its savepoint and skipped. Any other error
 * (a deadlock, a lock timeout, a lost connection, a bug) fails the batch, so
 * it is retried or reported, never taken for one bad CI.
 */
export function isCiDataError(error: unknown): boolean {
  const code = sqlState(error);
  return code !== undefined && (code.startsWith('22') || code.startsWith('23'));
}

/**
 * Whether a batch failed on a transient lock conflict a retry can clear:
 * serialization_failure (40001), deadlock_detected (40P01) or
 * lock_not_available (55P03, lock_timeout).
 */
export function isRetryableSqlError(error: unknown): boolean {
  const code = sqlState(error);
  return code === '40001' || code === '40P01' || code === '55P03';
}

/**
 * Takes, inside the caller's transaction, the per-CI transaction-scoped
 * advisory locks of a batch: pg_advisory_xact_lock(8271, hashtext(ci_id)),
 * the key PostgresClient.updateCIDimension also takes. The cmdb.dim_ci SCD
 * writers (neo4j-to-postgres, sync-cis-to-datamart) call it before reading any
 * current row. Held to COMMIT, so a concurrent writer re-reads the version
 * just written instead of the row it replaced; without it both could expire
 * one row and insert two current versions in different organizations (the
 * current-row index is not unique).
 *
 * Keys are taken once each, in ascending key order: hashtext can give two ids
 * one key, and ordering by id could then form a wait cycle (deadlock) between
 * two batches. Batches still wait for each other; they never wait in a cycle.
 * Every id must pass isDimCiId (callers filter with withDimCiIds first): an
 * id this cannot lock must not be processed.
 */
export async function lockCIDimensions(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> },
  ciIds: unknown[]
): Promise<void> {
  if (!ciIds.every(isDimCiId)) {
    throw new Error('CI dimension lock requires valid cmdb.dim_ci ci_ids');
  }
  const keys = await client.query(
    'SELECT DISTINCT hashtext(id) AS key FROM unnest($1::text[]) AS id ORDER BY key',
    [ciIds]
  );
  for (const { key } of keys.rows) {
    await client.query('SELECT pg_advisory_xact_lock(8271, $1::int)', [key]);
  }
}

/**
 * The organization of the next current version of a CI already in
 * cmdb.dim_ci, or null when its node conflicts with the stored history: the
 * caller then writes nothing for the CI. No stored row ever changes
 * organization: a pre-011 ci_id can carry several lineages (a CI deleted and
 * its id reused), so its rows cannot be attributed to the current node. The
 * decision uses only data no client can write (the stored row and its 011
 * backfill marker; a node's created_at, for example, can be rewritten):
 *  - a node without an organization can keep only an internal stored row;
 *    a customer row requires a matching node organization. An org-less node
 *    may reuse a deleted customer CI's id, so its stored row is not proof of
 *    the replacement node's ownership;
 *  - a node naming the stored organization keeps it;
 *  - a node naming another organization for a CI whose current row is a 011
 *    backfill label gets it for a NEW current version, built from the node
 *    alone (FD-4: a customer CI 011 backfilled to the internal organization).
 *    The backfilled history stays in the internal organization, so the
 *    node's organization sees none of it (no earlier tbm_attributes or cost);
 *  - every other mismatch is a conflict: rows labelled internal after 011 and
 *    customer organizations never get a version in another organization.
 * Writers clear the marker of every version they visit; a complete
 * neo4j-to-postgres sync clears the markers of every CI without a live node.
 */
export function storedCiOrganizationId(nodeOrganizationId: unknown, stored: StoredCiOrganization): string | null {
  if (nodeOrganizationId === null || nodeOrganizationId === undefined || nodeOrganizationId === '') {
    return stored.organizationId === INTERNAL_ORGANIZATION_ID ? INTERNAL_ORGANIZATION_ID : null;
  }
  const nodeOrganization = String(nodeOrganizationId).toLowerCase();
  if (nodeOrganization === stored.organizationId) {
    return stored.organizationId;
  }
  if (stored.backfilled && stored.organizationId === INTERNAL_ORGANIZATION_ID) {
    return nodeOrganization;
  }
  return null;
}
