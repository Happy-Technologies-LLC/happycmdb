// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard value formatting. The dashboard API returns null (or an empty list)
 * for any figure with no backing data and names it in the payload's
 * `unavailable` list. null must never render as 0, NaN or a made-up default.
 */

export const NOT_AVAILABLE = 'Not available yet';
export const EMPTY_VALUE = '—';

export const isKnown = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export function formatCurrency(value: number | null | undefined): string {
  if (!isKnown(value)) return EMPTY_VALUE;
  if (value >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  return isKnown(value) ? `${value.toFixed(digits)}%` : EMPTY_VALUE;
}

export function formatCount(value: number | null | undefined): string {
  return isKnown(value) ? value.toLocaleString() : EMPTY_VALUE;
}

export function formatDecimal(value: number | null | undefined, digits = 1): string {
  return isKnown(value) ? value.toFixed(digits) : EMPTY_VALUE;
}

/** Mean of the known values; null when none is known (never 0). */
export function averageKnown(values: Array<number | null | undefined>): number | null {
  const known = values.filter(isKnown);
  return known.length === 0 ? null : known.reduce((sum, v) => sum + v, 0) / known.length;
}

/** True when the payload reports `field` (or its whole section) as unavailable. */
export function isUnavailable(unavailable: string[] | undefined, field: string): boolean {
  return (unavailable ?? []).some(name => name === field || field.startsWith(`${name}.`));
}
