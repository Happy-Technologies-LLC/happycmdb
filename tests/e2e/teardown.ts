/**
 * E2E Test Global Teardown
 *
 * Stops the shared Testcontainers started in setup.ts.
 */

import type { StartedTestContainer } from 'testcontainers';

interface ContainerStore {
  __NEO4J_CONTAINER__?: StartedTestContainer;
  __POSTGRES_CONTAINER__?: StartedTestContainer;
  __REDIS_CONTAINER__?: StartedTestContainer;
}

const containerStore = globalThis as typeof globalThis & ContainerStore;

export default async function globalTeardown(): Promise<void> {
  console.log('Stopping E2E test containers...');

  try {
    if (containerStore.__NEO4J_CONTAINER__) {
      await containerStore.__NEO4J_CONTAINER__.stop();
      console.log('Neo4j container stopped');
    }

    if (containerStore.__POSTGRES_CONTAINER__) {
      await containerStore.__POSTGRES_CONTAINER__.stop();
      console.log('PostgreSQL container stopped');
    }

    if (containerStore.__REDIS_CONTAINER__) {
      await containerStore.__REDIS_CONTAINER__.stop();
      console.log('Redis container stopped');
    }

    console.log('All E2E test containers stopped successfully');
  } catch (error) {
    console.error('Error stopping E2E test containers:', error);
  }
}
