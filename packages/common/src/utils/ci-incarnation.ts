// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** A legacy or malformed graph incarnation never proves ownership of SQL rows. */
export function ciIncarnationId(ci: { _incarnation_id?: unknown; incarnation_id?: unknown } | string | null): string | null {
  const value = typeof ci === 'string' ? ci : ci?._incarnation_id ?? ci?.incarnation_id;
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value : null;
}

/** Maximum graph nodes inspected for a tenant's incarnation-fenced analytics. */
export const MAX_CI_ANALYTICS_NODES = 512;

export class CIAnalyticsLimitError extends Error {
  constructor() {
    super('CI analytics resource limit exceeded');
    this.name = 'CIAnalyticsLimitError';
  }
}
