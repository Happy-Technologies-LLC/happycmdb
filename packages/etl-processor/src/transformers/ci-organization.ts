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
   * Rows written after 011 are FALSE, so a TRUE current row means every
   * version of the CI is a backfilled row.
   */
  backfilled: boolean;
}

/**
 * The organization to write for a CI already in cmdb.dim_ci, or null when
 * its node conflicts with the stored history: the caller then writes nothing
 * for the CI (no version, no relabel). Decided only from data no client can
 * write: the stored row and its 011 backfill marker (a node's created_at, for
 * example, can be rewritten). So:
 *  - a node without an organization keeps the stored one (reconciliation
 *    recreates missing nodes without one);
 *  - a node naming the stored organization keeps it;
 *  - a node naming another organization for a CI whose rows are 011
 *    backfill labels takes it: that is a customer CI 011 backfilled to the
 *    internal organization (FD-4). Writers relabel every version and clear
 *    the marker; a complete neo4j-to-postgres sync clears every remaining
 *    marker, so this happens at most once per CI, before the first complete
 *    sync after 011;
 *  - every other mismatch is a conflict: rows labelled internal after 011 and
 *    customer organizations never move.
 */
export function storedCiOrganizationId(nodeOrganizationId: unknown, stored: StoredCiOrganization): string | null {
  if (nodeOrganizationId === null || nodeOrganizationId === undefined || nodeOrganizationId === '') {
    return stored.organizationId;
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
