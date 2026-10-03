// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Business-service ownership (FD-2). Postgres dim_business_services
 * .organization_id is the tenant authority for business-service ids, so every
 * Neo4j path keyed by a business-service id is gated by these lookups. A
 * service with no row owned by the organization (foreign, missing, or present
 * only in Neo4j) is not owned: callers fail closed.
 *
 * Ownership alone is not enough for Neo4j reads: service ids are chosen by the
 * client, so an organization can own an id that names another organization's
 * (or an org-less) :BusinessService node. Every Cypher match on
 * :BusinessService therefore also requires `organization_id = $organizationId`
 * on the node (FD-16 c).
 *
 * `organizationId` must come from the token (requestOrganizationId /
 * requireGraphQLOrganization), never from request params or body.
 */

import { getPostgresClient } from '@cmdb/database';

/** One REST 404 body for a foreign, missing, or Neo4j-only service so ownership is not observable. */
export const BUSINESS_SERVICE_NOT_FOUND = { success: false, error: 'Not Found', message: 'Business service not found' };

/** Ids of every business service the organization owns. */
export async function ownedBusinessServiceIds(organizationId: string): Promise<Set<string>> {
  const result = await getPostgresClient().query(
    'SELECT service_id FROM dim_business_services WHERE organization_id = $1',
    [organizationId]
  );
  return new Set(result.rows.map((row: { service_id: string }) => row.service_id));
}

/** Whether the organization owns the business service. */
export async function ownsBusinessService(organizationId: string, serviceId: string): Promise<boolean> {
  const result = await getPostgresClient().query(
    'SELECT 1 FROM dim_business_services WHERE organization_id = $1 AND service_id = $2',
    [organizationId, serviceId]
  );
  return result.rows.length > 0;
}
