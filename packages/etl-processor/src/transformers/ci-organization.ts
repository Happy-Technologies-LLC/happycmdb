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
 * cmdb.dim_ci.organization_id for a :CI node's organization_id property.
 *
 * The node's organization when it has one. :CI nodes written by unscoped
 * system writers (discovery, connectors, ETL, reconciliation) have none; they
 * belong to the internal organization (FD-4), never to a customer
 * organization. The value comes only from the stored node, never from a
 * request. PostgreSQL returns a uuid in lower case, so the value is lower
 * cased for change detection against the stored row. A malformed value is
 * passed through, so PostgreSQL rejects the row (22P02) instead of it
 * landing in some organization.
 */
export function dimCiOrganizationId(nodeOrganizationId: unknown): string {
  if (nodeOrganizationId === null || nodeOrganizationId === undefined || nodeOrganizationId === '') {
    return INTERNAL_ORGANIZATION_ID;
  }
  return String(nodeOrganizationId).toLowerCase();
}
