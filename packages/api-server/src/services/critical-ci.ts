// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The one definition of a "critical CI": its `bsm_business_criticality` is tier_1 or tier_2.
 *
 * `dashboard.service.ts` (executive risk matrix) and `analytics.controller.ts` (`critical_relationships` of
 * GET /analytics/dashboard) both read it from here so the two views cannot drift apart. Other readers that need
 * "critical" (for example the BW3 dashboard counts) MUST reuse it rather than restate the tier list.
 *
 * Pass the list as the `$criticalTiers` Cypher parameter (see {@link criticalTiersParam}); never interpolate it.
 */
export const CRITICAL_CI_TIERS: readonly string[] = Object.freeze(['tier_1', 'tier_2']);

/** The `{ criticalTiers }` Cypher parameter for a predicate `ci.bsm_business_criticality IN $criticalTiers`. */
export function criticalTiersParam(): { criticalTiers: string[] } {
  return { criticalTiers: [...CRITICAL_CI_TIERS] };
}
