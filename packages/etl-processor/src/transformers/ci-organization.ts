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
 * A CI's organization is fixed when the CI is created (POST /api/v1/cis
 * stamps it; nothing updates it), and every cmdb.dim_ci version of a ci_id
 * carries the same one. So:
 *  - a node that names its organization is authoritative. A stored row that
 *    differs was labelled by migration 011's internal-org backfill (FD-4)
 *    before the ETL saw the node; writers relabel every version of the CI;
 *  - a node without one (written by discovery, connectors, ETL or
 *    reconciliation) keeps the organization already stored for the CI, and
 *    a CI not yet in cmdb.dim_ci goes to the internal organization (FD-4).
 *    It never lands in, or moves to, a customer organization.
 *
 * The value comes only from stored data, never from a request. PostgreSQL
 * returns a uuid in lower case, so the node's value is lower cased for
 * comparison with the stored row. A malformed value is passed through, so
 * PostgreSQL rejects the row (22P02) instead of it landing in some
 * organization.
 */
export function dimCiOrganizationId(nodeOrganizationId: unknown, storedOrganizationId?: string): string {
  if (nodeOrganizationId === null || nodeOrganizationId === undefined || nodeOrganizationId === '') {
    return storedOrganizationId ?? INTERNAL_ORGANIZATION_ID;
  }
  return String(nodeOrganizationId).toLowerCase();
}
