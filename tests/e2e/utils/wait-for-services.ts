/**
 * Wait for Services Utility
 *
 * Functions to wait for various services to become healthy before running tests
 */

import * as http from 'http';
import { logger } from './logger';

interface WaitOptions {
  timeout?: number;
  interval?: number;
}

interface Neo4jWaitOptions extends WaitOptions {
  uri: string;
  user: string;
  password: string;
}

interface PostgresWaitOptions extends WaitOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

interface RedisWaitOptions extends WaitOptions {
  host: string;
  port: number;
}

interface ServiceWaitOptions extends WaitOptions {
  name: string;
  url: string;
}

/**
 * Generic retry function with exponential backoff
 */
async function retry<T>(
  fn: () => Promise<T>,
  options: WaitOptions & { name: string }
): Promise<T> {
  const timeout = options.timeout || 60000;
  const interval = options.interval || 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const result = await fn();
      return result;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeout) {
        throw new Error(
          `Timeout waiting for ${options.name} after ${timeout}ms: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      logger.debug(`${options.name} not ready, retrying in ${interval}ms...`);
      await sleep(interval);
    }
  }

  throw new Error(`Timeout waiting for ${options.name}`);
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait for Neo4j to be ready
 */
export async function waitForNeo4j(options: Neo4jWaitOptions): Promise<void> {
  logger.info(`Waiting for Neo4j at ${options.uri}...`);

  const neo4j = require('neo4j-driver');

  await retry(
    async () => {
      const driver = neo4j.driver(
        options.uri,
        neo4j.auth.basic(options.user, options.password)
      );

      try {
        const session = driver.session();
        await session.run('RETURN 1');
        await session.close();
        logger.success('Neo4j is ready');
      } finally {
        await driver.close();
      }
    },
    {
      name: 'Neo4j',
      timeout: options.timeout,
      interval: options.interval,
    }
  );
}

/**
 * Wait for PostgreSQL to be ready
 */
export async function waitForPostgres(options: PostgresWaitOptions): Promise<void> {
  logger.info(`Waiting for PostgreSQL at ${options.host}:${options.port}...`);

  const { Pool } = require('pg');

  await retry(
    async () => {
      const pool = new Pool({
        host: options.host,
        port: options.port,
        database: options.database,
        user: options.user,
        password: options.password,
        connectionTimeoutMillis: 3000,
      });

      try {
        await pool.query('SELECT 1');
        logger.success('PostgreSQL is ready');
      } finally {
        await pool.end();
      }
    },
    {
      name: 'PostgreSQL',
      timeout: options.timeout,
      interval: options.interval,
    }
  );
}

/**
 * Wait for Redis to be ready
 */
export async function waitForRedis(options: RedisWaitOptions): Promise<void> {
  logger.info(`Waiting for Redis at ${options.host}:${options.port}...`);

  const Redis = require('ioredis');

  await retry(
    async () => {
      const redis = new Redis({
        host: options.host,
        port: options.port,
        lazyConnect: true,
        retryStrategy: () => null, // Don't retry on connection failure
      });

      try {
        await redis.connect();
        await redis.ping();
        logger.success('Redis is ready');
      } finally {
        redis.disconnect();
      }
    },
    {
      name: 'Redis',
      timeout: options.timeout,
      interval: options.interval,
    }
  );
}

/**
 * Wait for HTTP service to be ready
 */
export async function waitForService(options: ServiceWaitOptions): Promise<void> {
  logger.info(`Waiting for ${options.name} at ${options.url}...`);

  await retry(
    async () => {
      return new Promise<void>((resolve, reject) => {
        const req = http.get(options.url, (res) => {
          if (res.statusCode === 200) {
            logger.success(`${options.name} is ready`);
            resolve();
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });

        req.on('error', reject);
        req.setTimeout(3000, () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
      });
    },
    {
      name: options.name,
      timeout: options.timeout,
      interval: options.interval,
    }
  );
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => Promise<boolean>,
  options: WaitOptions & { name: string }
): Promise<void> {
  await retry(
    async () => {
      const result = await condition();
      if (!result) {
        throw new Error('Condition not met');
      }
    },
    options
  );
}
