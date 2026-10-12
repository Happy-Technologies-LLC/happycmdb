// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Express handlers for service health, readiness, and liveness.
 */

import { Request, Response } from 'express';
import { HealthCheckService } from './health-check.service';
import { getNeo4jClient } from '@cmdb/database';
import { getRedisClient } from '@cmdb/database';
import { getLogger } from '@cmdb/common';

const logger = getLogger();

export class HealthController {
  private healthService: HealthCheckService;

  constructor() {
    this.healthService = new HealthCheckService(process.env['APP_VERSION'] || '1.0.0');
  }

  /**
   * GET /health - Comprehensive health check
   */
  async getHealth(_req: Request, res: Response): Promise<void> {
    try {
      const health = await this.healthService.checkHealth();

      const statusCode = this.getStatusCode(health._status);
      res.status(statusCode).json(health);
    } catch (error: any) {
      res.status(503).json({
        _status: 'unhealthy',
        _message: `Health check failed: ${error.message}`,
        _timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * GET /ready - Readiness check (can accept traffic)
   */
  async getReadiness(_req: Request, res: Response): Promise<void> {
    try {
      const readiness = await this.healthService.checkReadiness();

      res.status(readiness.ready ? 200 : 503).json({
        _ready: readiness.ready,
        _message: readiness.message,
        _timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(503).json({
        _ready: false,
        _message: `Readiness check failed: ${error.message}`,
        _timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * GET /alive - Liveness check (still running)
   */
  async getLiveness(_req: Request, res: Response): Promise<void> {
    try {
      const liveness = await this.healthService.checkLiveness();

      res.status(liveness.alive ? 200 : 503).json({
        _alive: liveness.alive,
        _message: liveness.message,
        _timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      res.status(503).json({
        _alive: false,
        _message: `Liveness check failed: ${error.message}`,
        _timestamp: new Date().toISOString(),
      });
    }
  }
  /**
   * GET /health/services - Service health status
   */
  async getServices(_req: Request, res: Response): Promise<void> {
    try {
      const services = [];

      // Check Neo4j
      try {
        const neo4j = getNeo4jClient();
        const session = neo4j.getSession();
        const start = Date.now();
        await session.run('RETURN 1');
        const responseTime = Date.now() - start;
        await session.close();

        services.push({
          service: 'Neo4j',
          status: 'healthy' as const,
          last_check: new Date().toISOString(),
          response_time_ms: responseTime,
        });
      } catch (error) {
        services.push({
          service: 'Neo4j',
          status: 'down' as const,
          last_check: new Date().toISOString(),
        });
      }

      // Check Redis
      try {
        const redis = getRedisClient();
        const start = Date.now();
        await redis.set('health:check', 'ok', 10);
        await redis.get('health:check');
        const responseTime = Date.now() - start;

        services.push({
          service: 'Redis',
          status: 'healthy' as const,
          last_check: new Date().toISOString(),
          response_time_ms: responseTime,
        });
      } catch (error) {
        services.push({
          service: 'Redis',
          status: 'down' as const,
          last_check: new Date().toISOString(),
        });
      }

      // Add other services (mock data for now)
      services.push(
        {
          service: 'PostgreSQL',
          status: 'healthy' as const,
          last_check: new Date().toISOString(),
          response_time_ms: 15,
        },
        {
          service: 'Discovery Engine',
          status: 'healthy' as const,
          last_check: new Date().toISOString(),
          response_time_ms: 8,
        },
        {
          service: 'ETL Processor',
          status: 'healthy' as const,
          last_check: new Date().toISOString(),
          response_time_ms: 12,
        }
      );

      res.json(services);
    } catch (error: any) {
      logger.error('Failed to fetch service health', error, {
        operation: 'getServices',
        endpoint: '/health/services',
      });
      res.status(500).json({
        error: 'Failed to fetch service health',
        message: error.message,
      });
    }
  }

  /**
   * Map health status to HTTP status code
   */
  private getStatusCode(status: string): number {
    switch (status) {
      case 'healthy':
        return 200;
      case 'degraded':
        return 200; // Still accepting traffic
      case 'unhealthy':
        return 503;
      default:
        return 500;
    }
  }
}
