// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-972: destructive integration suites call this at module load and refuse to run unless the root
 * Testcontainers global setup marked this run (CMDB_TESTCONTAINERS_RUN_ID) and the target is a loopback
 * `cmdb_test`. A cooperative guard against accidents, not proof of provenance: never point any suite at a
 * shared, real or staging database.
 */
const LOOPBACK: Record<string, true> = { localhost: true, '127.0.0.1': true, '::1': true, '[::1]': true };
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertIsolatedIntegrationTarget(env: NodeJS.ProcessEnv = process.env): void {
  let neo4j: URL | undefined;
  try {
    neo4j = new URL(env['NEO4J_URI'] ?? '');
  } catch {
    // Unparseable or unset: refused below.
  }
  // bolt: only: a neo4j:// routing URI can hand the driver non-loopback cluster members.
  if (!RUN_ID.test(env['CMDB_TESTCONTAINERS_RUN_ID'] ?? '') || neo4j?.protocol !== 'bolt:'
    || LOOPBACK[neo4j.hostname] !== true || LOOPBACK[env['POSTGRES_HOST'] ?? ''] !== true
    || env['POSTGRES_DB'] !== 'cmdb_test') {
    // Never include environment values: they may name a shared host or carry credentials.
    throw new Error('HAP-972: refusing a destructive integration suite outside the root '
      + 'Testcontainers run (npm run test:integration). Never use a shared or real database.');
  }
}
