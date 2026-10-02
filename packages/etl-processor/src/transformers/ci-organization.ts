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

/** The organization of a CI already in cmdb.dim_ci (all its versions carry the same one). */
export interface StoredCiOrganization {
  organizationId: string;
  /** Earliest effective_from of any version of the ci_id. */
  firstEffectiveFrom: Date;
}

/**
 * The organization to write for a CI already in cmdb.dim_ci, or null when
 * its node conflicts with the stored history: the caller then writes nothing
 * for the CI (no version, no relabel). A CI's organization is fixed when its
 * node is created (POST /api/v1/cis stamps it; nothing updates it), but a
 * ci_id can be reused once its node is deleted, while its cmdb.dim_ci
 * history stays. So:
 *  - a node without an organization keeps the stored one (reconciliation
 *    recreates missing nodes without one);
 *  - a node naming the stored organization keeps it;
 *  - a node naming another organization for a CI stored in the internal
 *    organization relabels every version to it only when the node is older
 *    than the history (its created_at <= the first effective_from): that is
 *    a customer CI migration 011 backfilled to the internal organization
 *    (FD-4). A newer node reuses the id of a deleted CI and must not claim
 *    its history;
 *  - every other mismatch (including a customer organization the node does
 *    not name) is a conflict. A customer organization is never changed.
 */
export function storedCiOrganizationId(
  nodeOrganizationId: unknown,
  nodeCreatedAt: unknown,
  stored: StoredCiOrganization
): string | null {
  if (nodeOrganizationId === null || nodeOrganizationId === undefined || nodeOrganizationId === '') {
    return stored.organizationId;
  }
  const nodeOrganization = String(nodeOrganizationId).toLowerCase();
  if (nodeOrganization === stored.organizationId) {
    return stored.organizationId;
  }
  const createdAt = new Date(String(nodeCreatedAt)).getTime();
  if (
    stored.organizationId === INTERNAL_ORGANIZATION_ID &&
    !Number.isNaN(createdAt) &&
    createdAt <= stored.firstEffectiveFrom.getTime()
  ) {
    return nodeOrganization;
  }
  return null;
}
