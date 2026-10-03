// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Monthly CI cost trend for one organization, shared by
 * GET /api/v1/tbm/costs/trends and GraphQL costTrends (both admin-only, FD-3 b).
 *
 * Reads cmdb.dim_ci, the SCD Type-2 dimension that versions CI attributes
 * (including TBM monthly_cost) over time; ci_snapshot does not exist in any
 * migration. Each CI version is bucketed by the month it became effective,
 * approximating a monthly cost trend from dimensional history. Only rows of
 * `organizationId` count (cmdb.dim_ci.organization_id, migration 011).
 *
 * `organizationId` must come from the token (requestOrganizationId /
 * requireGraphQLOrganization), never from request params or body.
 */

import { getPostgresClient } from '@cmdb/database';

export interface CostTrendPoint {
  month: Date;
  totalCost: number;
  ciCount: number;
}

/** `months` outside 1..36 is clamped; a non-integer means the default, 6. */
export async function ciCostTrends(organizationId: string, months: number): Promise<CostTrendPoint[]> {
  const monthsBack = Math.min(Math.max(Number.isInteger(months) ? months : 6, 1), 36);

  const result = await getPostgresClient().pool.query(
    `
    SELECT
      date_trunc('month', effective_from) as month,
      sum((tbm_attributes->>'monthly_cost')::numeric) as total_cost,
      count(DISTINCT ci_id) as ci_count
    FROM cmdb.dim_ci
    WHERE organization_id = $2
      AND effective_from >= NOW() - ($1 * INTERVAL '1 month')
      AND tbm_attributes->>'monthly_cost' IS NOT NULL
    GROUP BY date_trunc('month', effective_from)
    ORDER BY month DESC
    `,
    [monthsBack, organizationId]
  );

  return result.rows.map((row) => ({
    month: row.month,
    totalCost: parseFloat(row.total_cost),
    ciCount: parseInt(row.ci_count),
  }));
}
