// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { CI } from '@cmdb/common';

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
 * The per-CI transaction-scoped advisory lock the cmdb.dim_ci SCD writers
 * (neo4j-to-postgres, sync-cis-to-datamart and
 * PostgresClient.updateCIDimension, which uses the same key) take before
 * reading a CI's current row. Held to COMMIT, so a concurrent writer re-reads
 * the version just written instead of the row it replaced; without it both
 * could expire one row and insert two current versions in different
 * organizations (the current-row index is not unique). Writers lock a batch in
 * ci_id order so two batches do not deadlock.
 */
export const CI_DIMENSION_LOCK_SQL = 'SELECT pg_advisory_xact_lock(8271, hashtext($1))';

/** A batch in the order its per-CI locks must be taken (see CI_DIMENSION_LOCK_SQL). */
export function inLockOrder<T>(cis: T[], ciId: (ci: T) => unknown): T[] {
  return [...cis].sort((a, b) => {
    const x = String(ciId(a));
    const y = String(ciId(b));
    return x < y ? -1 : x > y ? 1 : 0;
  });
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
