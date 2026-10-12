// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** Resolver fallbacks for omitted or null GraphQL page arguments. */
export const GRAPHQL_PAGE_DEFAULTS = {
  getCIs: 100,
  searchCIs: 50,
  configurationItems: 50,
  ciHistory: 100,
  cisDueForAudit: 100,
  history: 100,
  connectorRuns: 50,
  runs: 50,
  listConflicts: 100,
} as const;

/** Conservative allowance for list producers without an explicit page argument. */
export const MAX_GRAPHQL_PAGE_SIZE = 100;

export function normalizePagination(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

export function defaultGraphQLPageSize(fieldName: string, schemaDefault: unknown): number {
  if (typeof schemaDefault === 'number' && Number.isInteger(schemaDefault)) return schemaDefault;
  return GRAPHQL_PAGE_DEFAULTS[fieldName as keyof typeof GRAPHQL_PAGE_DEFAULTS] ?? MAX_GRAPHQL_PAGE_SIZE;
}
