// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant-scoped react-query keys. The dashboards' data is computed server-side from the caller's organization, so a
 * cached response is only valid for the organization that fetched it: every such key carries the organization id.
 * The organization sits straight after the query name, so `invalidateQueries({ queryKey: [name] })` still matches.
 * `null` (a platform administrator, or no user yet) is its own scope, never another organization's.
 */
export const NO_ORGANIZATION = 'no-organization';

export const orgScopedKey = (
  name: string,
  organizationId: string | null | undefined,
  ...rest: ReadonlyArray<string | number | boolean | null | undefined>
) => [name, organizationId ?? NO_ORGANIZATION, ...rest] as const;
