/**
 * E2E Test Global Setup
 *
 * Starts shared backing services (Neo4j, PostgreSQL/TimescaleDB, Redis) via
 * Testcontainers, loads the canonical database schema, initializes Neo4j
 * constraints/indexes, and exports connection details as environment variables.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import neo4j from 'neo4j-driver';

interface ContainerStore {
  __NEO4J_CONTAINER__?: StartedTestContainer;
  __POSTGRES_CONTAINER__?: StartedTestContainer;
  __REDIS_CONTAINER__?: StartedTestContainer;
}

const containerStore = globalThis as typeof globalThis & ContainerStore;

const POSTGRES_USER = 'test';
const POSTGRES_PASSWORD = 'testpassword';
const POSTGRES_DB = 'cmdb_test';
const NEO4J_PASSWORD = 'testpassword';

const SCHEMA_PATH = resolve(
  process.cwd(),
  'packages/database/src/postgres/migrations/001_complete_schema.sql'
);

export default async function globalSetup(): Promise<void> {
  console.log('Starting E2E test containers...');

  try {
    // ---- Neo4j -------------------------------------------------------------
    console.log('Starting Neo4j container...');
    const neo4jContainer = await new GenericContainer('neo4j:5.15.0')
      .withExposedPorts(7687, 7474)
      .withEnvironment({
        NEO4J_AUTH: `neo4j/${NEO4J_PASSWORD}`,
        NEO4J_PLUGINS: '["apoc"]',
      })
      .withWaitStrategy(Wait.forLogMessage('Started.'))
      .withStartupTimeout(120000)
      .start();

    const neo4jBoltPort = neo4jContainer.getMappedPort(7687);
    process.env.NEO4J_URI = `bolt://localhost:${neo4jBoltPort}`;
    process.env.NEO4J_USERNAME = 'neo4j';
    process.env.NEO4J_PASSWORD = NEO4J_PASSWORD;
    containerStore.__NEO4J_CONTAINER__ = neo4jContainer;
    console.log(`Neo4j started on ${process.env.NEO4J_URI}`);

    await initializeNeo4jSchema(process.env.NEO4J_URI, NEO4J_PASSWORD);
    console.log('Neo4j schema initialized');

    // ---- PostgreSQL / TimescaleDB -----------------------------------------
    console.log('Starting PostgreSQL (TimescaleDB) container...');
    const postgresContainer = await new GenericContainer('timescale/timescaledb:latest-pg15')
      .withExposedPorts(5432)
      .withEnvironment({ POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD })
      .withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
      .withStartupTimeout(120000)
      .start();

    const postgresPort = postgresContainer.getMappedPort(5432);
    process.env.POSTGRES_HOST = 'localhost';
    process.env.POSTGRES_PORT = String(postgresPort);
    process.env.POSTGRES_DB = POSTGRES_DB;
    process.env.POSTGRES_USER = POSTGRES_USER;
    process.env.POSTGRES_PASSWORD = POSTGRES_PASSWORD;
    containerStore.__POSTGRES_CONTAINER__ = postgresContainer;
    console.log(`PostgreSQL started on localhost:${postgresPort}`);

    await loadPostgresSchema(postgresContainer);
    console.log('PostgreSQL schema loaded');

    // ---- Redis -------------------------------------------------------------
    console.log('Starting Redis container...');
    const redisContainer = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .withStartupTimeout(60000)
      .start();

    const redisPort = redisContainer.getMappedPort(6379);
    process.env.REDIS_HOST = 'localhost';
    process.env.REDIS_PORT = String(redisPort);
    containerStore.__REDIS_CONTAINER__ = redisContainer;
    console.log(`Redis started on localhost:${redisPort}`);

    // ---- Secrets required by services at import time ----------------------
    process.env.CREDENTIAL_ENCRYPTION_KEY =
      process.env.CREDENTIAL_ENCRYPTION_KEY ||
      'test-encryption-key-minimum-32-chars-required-for-security';
    process.env.JWT_SECRET =
      process.env.JWT_SECRET || 'test-jwt-secret-for-e2e-tests';

    console.log('All E2E test containers started successfully');
  } catch (error) {
    console.error('Failed to start E2E test containers:', error);
    throw error;
  }
}

/**
 * Initialize Neo4j constraints/indexes. Idempotent — uses IF NOT EXISTS.
 */
async function initializeNeo4jSchema(uri: string, password: string): Promise<void> {
  const driver = neo4j.driver(uri, neo4j.auth.basic('neo4j', password));
  const session = driver.session();
  try {
    await session.run(
      'CREATE CONSTRAINT ci_id_unique IF NOT EXISTS FOR (ci:CI) REQUIRE ci.id IS UNIQUE'
    );
    await session.run('CREATE INDEX ci_type_idx IF NOT EXISTS FOR (ci:CI) ON (ci.type)');
    await session.run('CREATE INDEX ci_status_idx IF NOT EXISTS FOR (ci:CI) ON (ci.status)');
    await session.run(
      'CREATE INDEX ci_environment_idx IF NOT EXISTS FOR (ci:CI) ON (ci.environment)'
    );
    await session.run('CREATE INDEX ci_name_idx IF NOT EXISTS FOR (ci:CI) ON (ci.name)');
    await session.run(
      `CREATE FULLTEXT INDEX ci_search IF NOT EXISTS
       FOR (ci:CI) ON EACH [ci.name, ci.type, ci.external_id]`
    );
  } finally {
    await session.close();
    await driver.close();
  }
}

/**
 * Load the canonical PostgreSQL schema into the running container.
 */
async function loadPostgresSchema(container: StartedTestContainer): Promise<void> {
  const schemaSql = readFileSync(SCHEMA_PATH, 'utf-8');
  await container.copyContentToContainer([{ content: schemaSql, target: '/tmp/schema.sql' }]);

  const load = await container.exec([
    'psql', '-v', 'ON_ERROR_STOP=0',
    '-U', POSTGRES_USER, '-d', POSTGRES_DB, '-f', '/tmp/schema.sql',
  ]);
  if (load.exitCode !== 0) {
    console.warn(`psql schema load exited with code ${load.exitCode} (non-fatal notices expected)`);
  }

  const check = await container.exec([
    'psql', '-U', POSTGRES_USER, '-d', POSTGRES_DB, '-tAc',
    "SELECT count(*) FROM information_schema.tables WHERE table_name = 'api_keys'",
  ]);
  if (check.output.trim() !== '1') {
    throw new Error(
      `PostgreSQL schema load failed: core table 'api_keys' missing (psql output: ${check.output.trim()})`
    );
  }
}
