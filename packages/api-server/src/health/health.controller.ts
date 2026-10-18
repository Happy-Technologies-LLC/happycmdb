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
import type { Session } from 'neo4j-driver';

const logger = getLogger();

type ServiceHealth = {
  service: string;
  status: 'healthy' | 'down';
  last_check: string;
  response_time_ms?: number;
};

const SERVICE_CACHE_MS = 5000;

export class HealthController {
  private healthService: HealthCheckService;
  private servicesCache?: { value: ServiceHealth[]; expiresAt: number };
  private servicesInFlight?: Promise<ServiceHealth[]>;

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
    } catch {
      res.status(503).json({
        _status: 'unhealthy',
        _message: 'Health check failed',
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
    } catch {
      res.status(503).json({
        _ready: false,
        _message: 'Readiness check failed',
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
    } catch {
      res.status(503).json({
        _alive: false,
        _message: 'Liveness check failed',
        _timestamp: new Date().toISOString(),
      });
    }
  }
  /**
   * GET /health/services - Service health status
   */
  async getServices(_req: Request, res: Response): Promise<void> {
    try {
      if (this.servicesCache && Date.now() < this.servicesCache.expiresAt) {
        res.json(this.servicesCache.value);
        return;
      }
      if (!this.servicesInFlight) {
        this.servicesInFlight = this.probeServices().then(services => {
          // Expiry begins when the probe completes, not when the request arrives.
          this.servicesCache = { value: services, expiresAt: Date.now() + SERVICE_CACHE_MS };
          return services;
        }).finally(() => {
          this.servicesInFlight = undefined;
        });
      }
      res.json(await this.servicesInFlight);
    } catch {
      logger.error('Failed to fetch service health', new Error('Service health probe failed'), { operation: 'getServices' });
      res.status(500).json({ error: 'Failed to fetch service health' });
    }
  }

  private async probeServices(): Promise<ServiceHealth[]> {
    const services: ServiceHealth[] = [];

    let session: Session | undefined;
    try {
      session = getNeo4jClient().getSession();
      const start = Date.now();
      await session.run('RETURN 1');
      services.push({
        service: 'Neo4j',
        status: 'healthy',
        last_check: new Date().toISOString(),
        response_time_ms: Date.now() - start,
      });
    } catch {
      services.push({ service: 'Neo4j', status: 'down', last_check: new Date().toISOString() });
    } finally {
      if (session) {
        try {
          await session.close();
        } catch {
          // Closing failure must not prevent Redis from being checked.
        }
      }
    }

    try {
      const redis = getRedisClient();
      const start = Date.now();
      await redis.set('health:check', 'ok', 10);
      await redis.get('health:check');
      services.push({
        service: 'Redis',
        status: 'healthy',
        last_check: new Date().toISOString(),
        response_time_ms: Date.now() - start,
      });
    } catch {
      services.push({ service: 'Redis', status: 'down', last_check: new Date().toISOString() });
    }

    // Existing static entries retained for the UI response contract.
    services.push(
      { service: 'PostgreSQL', status: 'healthy', last_check: new Date().toISOString(), response_time_ms: 15 },
      { service: 'Discovery Engine', status: 'healthy', last_check: new Date().toISOString(), response_time_ms: 8 },
      { service: 'ETL Processor', status: 'healthy', last_check: new Date().toISOString(), response_time_ms: 12 }
    );
    return services;
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
