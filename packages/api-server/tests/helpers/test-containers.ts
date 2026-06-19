// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Test Database Helper
 *
 * Connects integration suites to the shared Testcontainers that are started
 * ONCE in tests/setup/integration.global-setup.ts (Neo4j +
 * PostgreSQL/TimescaleDB, with the canonical schema loaded). It does NOT start
 * its own containers — it reads the connection details from the environment
 * variables the global setup exports, so every suite shares one coherent set of
 * containers rather than spinning up conflicting duplicates.
 */

import neo4j, { Driver } from 'neo4j-driver';
import { PostgresClient, getPostgresClient } from '@cmdb/database';

export interface TestDatabaseContext {
  neo4jDriver: Driver;
  postgresClient: PostgresClient;
}

let testContext: TestDatabaseContext | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. The integration containers must be started by the global ` +
        `setup (tests/setup/integration.global-setup.ts) before any suite runs.`
    );
  }
  return value;
}

/**
 * Connect to the shared test containers. Returns a cached context for the
 * lifetime of the current test file.
 */
export async function startTestContainers(): Promise<TestDatabaseContext> {
  if (testContext) {
    return testContext;
  }

  const neo4jUri = requireEnv('NEO4J_URI');
  const neo4jUser = process.env.NEO4J_USERNAME || 'neo4j';
  const neo4jPassword = requireEnv('NEO4J_PASSWORD');

  const neo4jDriver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));
  await waitForNeo4j(neo4jDriver);

  // Shared singleton that reads POSTGRES_* env vars set by the global setup.
  const postgresClient = getPostgresClient();

  testContext = { neo4jDriver, postgresClient };
  return testContext;
}

/**
 * Close the per-file Neo4j driver. The PostgreSQL singleton and the underlying
 * containers are owned by the global setup/teardown and are intentionally left
 * running here.
 */
export async function stopTestContainers(): Promise<void> {
  if (!testContext) {
    return;
  }
  await testContext.neo4jDriver.close();
  testContext = null;
}

/**
 * Remove all Neo4j nodes/relationships between tests. CI graph data lives in
 * Neo4j; PostgreSQL fixtures are cleaned up by the suites that create them.
 */
export async function cleanDatabases(): Promise<void> {
  if (!testContext) {
    throw new Error('Test containers not started. Call startTestContainers() first.');
  }

  const session = testContext.neo4jDriver.session();
  try {
    await session.run('MATCH (n) DETACH DELETE n');
  } finally {
    await session.close();
  }
}

/**
 * Get current test context.
 */
export function getTestContext(): TestDatabaseContext {
  if (!testContext) {
    throw new Error('Test containers not started. Call startTestContainers() first.');
  }
  return testContext;
}

/**
 * Wait for Neo4j to be ready by attempting a trivial query.
 */
async function waitForNeo4j(driver: Driver, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const session = driver.session();
      await session.run('RETURN 1');
      await session.close();
      return;
    } catch {
      if (i === maxAttempts - 1) {
        throw new Error('Neo4j did not become ready in time');
      }
      await delay(1000);
    }
  }
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
