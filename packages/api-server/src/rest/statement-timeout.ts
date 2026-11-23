// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/*
 * The statement_timeout knobs' one validation. This module MUST stay free of imports: the operator scripts reach it
 * through services/business-service-reference.ts, and an import of the @cmdb/database barrel would open the API
 * server's Redis connection at load time (see scripts/operator-stores.ts).
 */

/**
 * HAP-2080: PostgreSQL stores statement_timeout as int4 milliseconds and rejects a larger value, which would fail
 * every bounded read with a 500. Above this bound the default applies instead.
 */
export const MAX_STATEMENT_TIMEOUT_MS = 2147483647;

/** A positive integer no greater than the int4 ceiling, else `fallback`. */
export function boundedStatementTimeoutMs(raw: string | undefined, fallback: number): number {
  const configured = Number(raw);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= MAX_STATEMENT_TIMEOUT_MS ? configured : fallback;
}
