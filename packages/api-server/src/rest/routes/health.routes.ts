// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router, Request, Response } from 'express';
import { getNeo4jClient, getPostgresClient, getRedisClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { parseKafkaBrokers } from '@cmdb/event-processor';

export const healthRoutes = Router();

interface HealthCheckResult {
  _status: 'ok' | 'degraded' | 'error';
  _timestamp: string;
  _uptime: number;
  _services: {
    _neo4j: ServiceStatus;
    _postgres: ServiceStatus;
    _redis: ServiceStatus;
    _kafka: ServiceStatus;
  };
}

interface ServiceStatus {
  _status: 'healthy' | 'unhealthy';
  _responseTime?: number;
  _error?: string;
}

// Basic health check endpoint
healthRoutes.get('/', async (__req: Request, res: Response) => {
  const healthCheck: HealthCheckResult = {
    _status: 'ok',
    _timestamp: new Date().toISOString(),
    _uptime: process.uptime(),
    _services: {
      _neo4j: { _status: 'unhealthy' },
      _postgres: { _status: 'unhealthy' },
      _redis: { _status: 'unhealthy' },
      _kafka: { _status: 'unhealthy' },
    },
  };

  // Check Neo4j connectivity
  try {
    const neo4jStart = Date.now();
    const neo4jClient = getNeo4jClient();
    const session = neo4jClient.getSession();

    try {
      await session.run('RETURN 1 AS health');
      healthCheck._services._neo4j = {
        _status: 'healthy',
        _responseTime: Date.now() - neo4jStart,
      };
    } finally {
      await session.close();
    }
  } catch (error) {
    logger.error('Neo4j health check failed', { error });
    healthCheck._services._neo4j = {
      _status: 'unhealthy',
      _error: error instanceof Error ? error.message : 'Unknown error',
    };
    healthCheck._status = 'degraded';
  }

  // Check PostgreSQL connectivity
  try {
    const pgStart = Date.now();
    const pgClient = getPostgresClient();
    await pgClient.query('SELECT 1 AS health');
    healthCheck._services._postgres = {
      _status: 'healthy',
      _responseTime: Date.now() - pgStart,
    };
  } catch (error) {
    logger.error('PostgreSQL health check failed', { error });
    healthCheck._services._postgres = {
      _status: 'unhealthy',
      _error: error instanceof Error ? error.message : 'Unknown error',
    };
    healthCheck._status = 'degraded';
  }

  // Check Redis connectivity
  try {
    const redisStart = Date.now();
    const redisClient = getRedisClient();
    const testKey = '__health_check__';
    await redisClient.set(testKey, 'test', 1);
    await redisClient.get(testKey);
    healthCheck._services._redis = {
      _status: 'healthy',
      _responseTime: Date.now() - redisStart,
    };
  } catch (error) {
    logger.error('Redis health check failed', { error });
    healthCheck._services._redis = {
      _status: 'unhealthy',
      _error: error instanceof Error ? error.message : 'Unknown error',
    };
    healthCheck._status = 'degraded';
  }

  // Check Kafka connectivity (simplified - just check if env is configured)
  try {
    if (parseKafkaBrokers().length > 0) {
      healthCheck._services._kafka = {
        _status: 'healthy',
      };
    } else {
      healthCheck._services._kafka = {
        _status: 'unhealthy',
        _error: 'Kafka brokers not configured',
      };
      healthCheck._status = 'degraded';
    }
  } catch (error) {
    logger.error('Kafka health check failed', { error });
    healthCheck._services._kafka = {
      _status: 'unhealthy',
      _error: error instanceof Error ? error.message : 'Unknown error',
    };
    healthCheck._status = 'degraded';
  }

  // Determine overall status
  const allHealthy = Object.values(healthCheck._services).every(
    (service) => service._status === 'healthy'
  );

  if (!allHealthy) {
    const anyHealthy = Object.values(healthCheck._services).some(
      (service) => service._status === 'healthy'
    );
    healthCheck._status = anyHealthy ? 'degraded' : 'error';
  }

  const statusCode = healthCheck._status === 'ok' ? 200 : healthCheck._status === 'degraded' ? 200 : 503;

  res.status(statusCode).json(healthCheck);
});

// Readiness probe endpoint (all services must be healthy)
healthRoutes.get('/ready', async (__req: Request, res: Response) => {
  try {
    const neo4jClient = getNeo4jClient();
    const session = neo4jClient.getSession();

    try {
      await session.run('RETURN 1');
    } finally {
      await session.close();
    }

    const pgClient = getPostgresClient();
    await pgClient.query('SELECT 1');

    const redisClient = getRedisClient();
    const testKey = '__readiness_check__';
    await redisClient.set(testKey, 'test', 1);
    await redisClient.get(testKey);

    res.status(200).json({ status: 'ready' });
  } catch (error) {
    logger.error('Readiness check failed', { error });
    res.status(503).json({
      _status: 'not ready',
      _error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Liveness probe endpoint (minimal check)
healthRoutes.get('/live', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'alive' });
});
