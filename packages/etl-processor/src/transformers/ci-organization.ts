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
 * cmdb.dim_ci.organization_id for a :CI node's organization_id property and
 * the organization already stored for the CI (any version; all versions of a
 * ci_id carry the same one).
 *
 * A CI's organization is fixed when the CI is created (POST /api/v1/cis
 * stamps it; nothing updates it). So:
 *  - a CI stored in a customer organization stays there, whatever the node
 *    says. A node can lose its organization (reconciliation recreates
 *    missing nodes without one) and a re-run of the Neo4j backfill then
 *    names the internal organization; neither may move the CI;
 *  - a CI stored in the internal organization takes the organization its
 *    node names. That stored label came from migration 011's backfill (FD-4)
 *    or from an org-less node; writers relabel every version of the CI;
 *  - a CI new to cmdb.dim_ci takes its node's organization, or the internal
 *    organization when the node has none (FD-4).
 * A node without an organization therefore never puts a CI in, or moves it
 * to, a customer organization.
 *
 * The value comes only from stored data, never from a request. PostgreSQL
 * returns a uuid in lower case, so the node's value is lower cased for
 * comparison with the stored row. A malformed value is passed through, so
 * PostgreSQL rejects the row (22P02) instead of it landing in some
 * organization.
 */
export function dimCiOrganizationId(nodeOrganizationId: unknown, storedOrganizationId?: string): string {
  if (storedOrganizationId !== undefined && storedOrganizationId !== INTERNAL_ORGANIZATION_ID) {
    return storedOrganizationId;
  }
  if (nodeOrganizationId === null || nodeOrganizationId === undefined || nodeOrganizationId === '') {
    return INTERNAL_ORGANIZATION_ID;
  }
  return String(nodeOrganizationId).toLowerCase();
}
