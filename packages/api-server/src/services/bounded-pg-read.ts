// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * A PostgreSQL read bounded by a `statement_timeout`, for the incident-derived estate reads (CI health, the
 * open-incident ribbon, service availability). The pattern is `rest/edge-evidence.ts`: one transaction on one pooled
 * connection, `set_config('statement_timeout', ..., true)` first (transaction-local, so it never outlives the
 * connection's checkout), then the read's statements. A statement that outlasts the timeout fails with SQLSTATE
 * `57014` (`isStatementTimeout`); the caller maps that to its own degraded answer, never to a partial figure.
 *
 * The bound is per statement, not per request. It is NOT the concurrency admission of `executeBoundedAnalysis`: the
 * estate hub requests several of these feeds in parallel for one user, and that limiter would 503 siblings of one
 * page load.
 */

import { boundedStatementTimeoutMs } from '../rest/statement-timeout';

/** The one pg method a bounded read needs; both the pool and a pooled client satisfy it. */
export interface Sql {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** A client that can run a callback in a transaction (`PostgresClient`). */
export interface TransactionalSql {
  transaction<T>(callback: (client: Sql) => Promise<T>): Promise<T>;
}

/** statement_timeout of the ribbon and availability reads, in milliseconds (`ESTATE_FEED_TIMEOUT_MS`). */
export const ESTATE_FEED_TIMEOUT_MS = 5000;
/** statement_timeout of the CI health read, in milliseconds (`CI_HEALTH_TIMEOUT_MS`). */
export const CI_HEALTH_TIMEOUT_MS = 3000;

/** Positive integer up to the int4 ceiling, else the default (`boundedStatementTimeoutMs`). */
export const estateFeedTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number =>
  boundedStatementTimeoutMs(env['ESTATE_FEED_TIMEOUT_MS'], ESTATE_FEED_TIMEOUT_MS);
export const ciHealthTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number =>
  boundedStatementTimeoutMs(env['CI_HEALTH_TIMEOUT_MS'], CI_HEALTH_TIMEOUT_MS);

/** Runs `read` in a transaction whose statements are bounded by `timeoutMs`. Statements run one at a time. */
export function boundedPgRead<T>(pg: TransactionalSql, timeoutMs: number, read: (sql: Sql) => Promise<T>): Promise<T> {
  return pg.transaction(async client => {
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
    return read(client);
  });
}

/** PostgreSQL `query_canceled`: the statement exceeded `statement_timeout`. */
export function isStatementTimeout(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '57014';
}

/** The 503 body of a timed-out estate feed: the body and status of the recent-changes feed's resource limit. */
export const ESTATE_FEED_LIMIT_RESPONSE = { success: false, error: 'Analytics resource limit exceeded' } as const;
