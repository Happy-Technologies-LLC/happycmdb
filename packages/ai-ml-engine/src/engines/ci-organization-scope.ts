// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Cypher conditions for the CI tenant scope of an engine call.
 *
 * With an organization id, every condition restricts to that organization
 * (bound as $organizationId); with UNSCOPED_CI_ACCESS (system jobs) every
 * condition is `true`, matching every organization as before.
 */

import { organizationIdParam, neighbourScopePredicate, type CIOrganizationScope } from '@cmdb/database';

export interface CIScopeCypher {
  /** Value for the $organizationId parameter (null when unscoped). */
  organizationId: string | null;
  /** `variable` is a :CI of the organization. */
  node(variable: string): string;
  /** Every node of the path `variable` is in the organization. */
  path(variable: string): string;
  /** `variable`, adjacent to an in-scope CI, may be counted (see neighbourScopePredicate). */
  neighbour(variable: string): string;
}

export function ciScopeCypher(scope: CIOrganizationScope): CIScopeCypher {
  const organizationId = organizationIdParam(scope);
  if (organizationId === null) {
    return { organizationId, node: () => 'true', path: () => 'true', neighbour: () => 'true' };
  }
  return {
    organizationId,
    node: variable => `${variable}.organization_id = $organizationId`,
    path: variable => `all(n IN nodes(${variable}) WHERE n.organization_id = $organizationId)`,
    neighbour: variable => neighbourScopePredicate(variable),
  };
}
