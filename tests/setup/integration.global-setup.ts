/**
 * Integration Test Global Setup
 *
 * Starts the shared backing services (Neo4j, PostgreSQL/TimescaleDB, Redis) via
 * Testcontainers ONCE before the entire integration suite runs, loads the
 * canonical database schema, and exports their connection details as
 * environment variables. Every integration suite connects to these containers
 * through the standard `@cmdb/database` factories (which read these env vars) or
 * the `test-containers` helper — no suite starts its own containers.
 */

import { readdirSync, readFileSync } from 'fs';
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

const MIGRATIONS_DIR = resolve(process.cwd(), 'packages/database/src/postgres/migrations');

export default async function globalSetup(): Promise<void> {
  console.log('Starting integration test containers...');

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
    // The canonical schema (001_complete_schema.sql) requires the timescaledb
    // and uuid-ossp extensions, so we run the TimescaleDB image rather than
    // stock postgres.
    console.log('Starting PostgreSQL (TimescaleDB) container...');
    const postgresContainer = await new GenericContainer('timescale/timescaledb:latest-pg15')
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_DB,
        POSTGRES_USER,
        POSTGRES_PASSWORD,
      })
      // The TimescaleDB image bootstraps, shuts down, then restarts with the
      // extension preloaded — wait for the SECOND "ready" message.
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

    console.log('All integration test containers started successfully');
  } catch (error) {
    console.error('Failed to start integration test containers:', error);
    throw error;
  }
}

/**
 * Initialize Neo4j constraints/indexes that the integration suites rely on.
 * Idempotent — uses IF NOT EXISTS so re-running is safe.
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
 *
 * Applies every migration in packages/database/src/postgres/migrations in
 * sorted order (001_complete_schema, 002_oauth_substrate, ...), mirroring the
 * migrator's own discovery. Each file is executed via `psql` (statement-per-line
 * autocommit, ON_ERROR_STOP=0) so the expected non-fatal hypertable primary-key
 * notices do not abort the load. After loading we assert a core table and the
 * OAuth state table exist to catch a genuinely broken load.
 */
async function loadPostgresSchema(container: StartedTestContainer): Promise<void> {
  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf-8');
    const target = `/tmp/${file}`;
    await container.copyContentToContainer([{ content: sql, target }]);
    const load = await container.exec([
      'psql',
      '-v',
      'ON_ERROR_STOP=0',
      '-U',
      POSTGRES_USER,
      '-d',
      POSTGRES_DB,
      '-f',
      target,
    ]);
    if (load.exitCode !== 0) {
      console.warn(`psql load of ${file} exited with code ${load.exitCode} (non-fatal notices expected)`);
    }
  }

  const check = await container.exec([
    'psql',
    '-U',
    POSTGRES_USER,
    '-d',
    POSTGRES_DB,
    '-tAc',
    "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('api_keys', 'oauth_states')",
  ]);
  if (check.output.trim() !== '2') {
    throw new Error(
      `PostgreSQL schema load failed: expected core tables missing (psql output: ${check.output.trim()})`
    );
  }
}
