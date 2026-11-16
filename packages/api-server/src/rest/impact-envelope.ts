// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { getPostgresClient } from '@cmdb/database';

/**
 * HAP-2028: what an impact or dependency read is, and what it does not know.
 * Every traversal answers over the declared graph (Neo4j edges written by
 * operators, connectors and discovery). No runtime source (flow, trace or
 * connection observations) exists yet, so the result is reachability, never a
 * complete runtime blast radius. Additive fields only: consumers that ignore
 * them keep working.
 */
export const IMPACT_BASIS = 'declared_graph_reachability' as const;
export const RUNTIME_BLAST_RADIUS = 'not_established' as const;
export const COVERAGE_NOTE = 'Declared graph reachability only. A missing edge is not evidence of no dependency, and a CI '
  + 'that no source has reported may have relationships nobody has recorded. No runtime source is connected, so this is '
  + 'not a complete runtime blast radius.';

export interface ImpactEnvelope {
  basis: typeof IMPACT_BASIS;
  runtime_blast_radius: typeof RUNTIME_BLAST_RADIUS;
  coverage: {
    /** Distinct CIs the traversal returned (the root CI included for CI-rooted reads). */
    ci_nodes_in_scope: number;
    /** In-scope CIs with no `ci_source_lineage` row in the caller's organization, sorted. */
    unreported_ci_ids: string[];
    /** No receipt table exists yet (HAP-2029), so no runtime observation is ever in scope. */
    runtime_observed_receipts_in_scope: false;
    note: typeof COVERAGE_NOTE;
  };
}

/**
 * The envelope for a traversal that returned `ciIds`. The ids come from the
 * caller's own organization-scoped traversal; lineage is matched on the same
 * organization, so another organization's lineage never counts as a report and
 * a legacy NULL-organization row is never attributed.
 */
export async function impactEnvelope(organizationId: string, ciIds: Iterable<string>): Promise<ImpactEnvelope> {
  const ids = [...new Set(ciIds)];
  let unreported: string[] = [];
  if (ids.length > 0) {
    // One indexed anti-join over the traversal's own bounded node set.
    const result = await getPostgresClient().query(
      `SELECT c.ci_id FROM unnest($1::text[]) AS c(ci_id)
       WHERE NOT EXISTS (
         SELECT 1 FROM ci_source_lineage l WHERE l.organization_id = $2 AND l.ci_id = c.ci_id)`,
      [ids, organizationId]);
    unreported = result.rows.map((row: { ci_id: string }) => row.ci_id).sort();
  }
  return {
    basis: IMPACT_BASIS,
    runtime_blast_radius: RUNTIME_BLAST_RADIUS,
    coverage: {
      ci_nodes_in_scope: ids.length,
      unreported_ci_ids: unreported,
      runtime_observed_receipts_in_scope: false,
      note: COVERAGE_NOTE,
    },
  };
}
