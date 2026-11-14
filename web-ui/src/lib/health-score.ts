// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * The `health_score` of GET /analytics/dashboard is null while no CI health state exists (BW1); a 0 would read as
 * "everything is down". Returns the percentage text of a measured score (0 to 100), or null when it is unavailable,
 * so callers render the explicit "Not available yet" state instead of a number.
 */
export function formatHealthScore(score: number | null | undefined): string | null {
  return typeof score === 'number' && Number.isFinite(score) ? `${Math.round(score)}%` : null;
}
