// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Test support for the "internal errors never reach a response body" harnesses
 * (HAP-1733): every database/service getter returns a dependency whose every
 * call throws an Error carrying SECRET, the way a driver error quotes a URI.
 */

export const SECRET = 'bolt://svc:hunter2@neo4j.internal:7687 ECONNREFUSED';

/**
 * Deep proxy: any property is another proxy, any call or construction throws Error(SECRET), except
 * getSession(), which hands out another throwing proxy (the session is where the driver fails).
 */
export function throwing(): any {
  return new Proxy(function () {}, {
    get: (_target, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'getSession' ? throwing : throwing()),
    apply: () => { throw new Error(SECRET); },
    construct: () => { throw new Error(SECRET); },
  });
}

const GETTERS = [
  'getNeo4jClient', 'getPostgresClient', 'getRedisClient', 'getAuditService',
  'getUnifiedCredentialService', 'getCredentialSetService',
];

/** jest.mock factory for @cmdb/database: the real module with every client getter replaced. */
export function databaseModule(): Record<string, unknown> {
  const actual = jest.requireActual('@cmdb/database');
  return { ...actual, ...Object.fromEntries(GETTERS.map(name => [name, () => throwing()])) };
}

/** jest.mock factory for read-admission: CI list reads run their reader directly (the real one turns any failure into a 503). */
export function readAdmissionModule(): Record<string, unknown> {
  const actual = jest.requireActual('../../read-admission');
  return { ...actual, readCIList: (_organizationId: string, read: (pending: string[], timeoutMs: number) => unknown) => read([], 1000) };
}

/** Everything a handler logged at error level (args per call). */
export const loggedErrors: unknown[][] = [];

/**
 * What the shared winston config would write for one logger.error call: format.errors/json keep a top-level
 * Error's message and stack but serialize an Error nested in the metadata object as {}.
 */
export function loggedText(args: unknown[]): string {
  return args.map(arg => (arg instanceof Error ? JSON.stringify({ message: arg.message, stack: arg.stack }) : JSON.stringify(arg))).join(' ');
}

/** jest.mock factory for @cmdb/common: the real module with a recording logger. */
export function commonModule(): Record<string, unknown> {
  const actual = jest.requireActual('@cmdb/common');
  const quiet = () => undefined;
  return {
    ...actual,
    logger: { debug: quiet, info: quiet, warn: quiet, error: (...args: unknown[]) => { loggedErrors.push(args); } },
  };
}
