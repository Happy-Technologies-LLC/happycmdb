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
const SERVICE_PROBE_TIMEOUT_MS = 2000;

// A timed-out response must not wait for a driver forever. The underlying
// operation is still tracked separately: never open another session/command
// against a dependency until that physical operation (including close) settles.
async function withinProbeDeadline<T>(work: Promise<T>): Promise<T> {
  // The project TS lib predates Promise.withResolvers; the timer callback
  // needs the executor's rejection function.
  let timer: NodeJS.Timeout;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Service probe timed out')), SERVICE_PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer!);
  }
}

export class HealthController {
  private healthService: HealthCheckService;
  private servicesCache?: { value: ServiceHealth[]; expiresAt: number };
  private servicesInFlight?: Promise<ServiceHealth[]>;
  private neo4jPending?: Promise<ServiceHealth>;
  private redisPending?: Promise<ServiceHealth>;

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
    const services: ServiceHealth[] = [
      await this.probeNeo4j(),
      await this.probeRedis(),
    ];

    // Existing static entries retained for the UI response contract.
    services.push(
      { service: 'PostgreSQL', status: 'healthy', last_check: new Date().toISOString(), response_time_ms: 15 },
      { service: 'Discovery Engine', status: 'healthy', last_check: new Date().toISOString(), response_time_ms: 8 },
      { service: 'ETL Processor', status: 'healthy', last_check: new Date().toISOString(), response_time_ms: 12 }
    );
    return services;
  }

  private async probeNeo4j(): Promise<ServiceHealth> {
    if (!this.neo4jPending) {
      const pending = this.checkNeo4jService();
      this.neo4jPending = pending;
      const clear = () => {
        if (this.neo4jPending === pending) this.neo4jPending = undefined;
      };
      void pending.then(clear, clear);
    } else {
      // Timed-out physical work still owns the session; report down, do not amplify it.
      return { service: 'Neo4j', status: 'down', last_check: new Date().toISOString() };
    }
    try {
      return await withinProbeDeadline(this.neo4jPending);
    } catch {
      return { service: 'Neo4j', status: 'down', last_check: new Date().toISOString() };
    }
  }

  private async checkNeo4jService(): Promise<ServiceHealth> {
    let session: Session | undefined;
    let result: ServiceHealth = { service: 'Neo4j', status: 'down', last_check: new Date().toISOString() };
    try {
      session = getNeo4jClient().getSession();
      const start = Date.now();
      await session.run('RETURN 1', {}, { timeout: SERVICE_PROBE_TIMEOUT_MS });
      result = { service: 'Neo4j', status: 'healthy', last_check: new Date().toISOString(), response_time_ms: Date.now() - start };
    } catch {
      // No driver exception details enter the response.
    } finally {
      if (session) {
        try {
          await session.close();
        } catch {
          result = { service: 'Neo4j', status: 'down', last_check: new Date().toISOString() };
        }
      }
    }
    return result;
  }

  private async probeRedis(): Promise<ServiceHealth> {
    if (!this.redisPending) {
      const pending = this.checkRedisService();
      this.redisPending = pending;
      const clear = () => {
        if (this.redisPending === pending) this.redisPending = undefined;
      };
      void pending.then(clear, clear);
    } else {
      return { service: 'Redis', status: 'down', last_check: new Date().toISOString() };
    }
    try {
      return await withinProbeDeadline(this.redisPending);
    } catch {
      return { service: 'Redis', status: 'down', last_check: new Date().toISOString() };
    }
  }

  private async checkRedisService(): Promise<ServiceHealth> {
    try {
      const redis = getRedisClient();
      const start = Date.now();
      await redis.set('health:check', 'ok', 10);
      await redis.get('health:check');
      return { service: 'Redis', status: 'healthy', last_check: new Date().toISOString(), response_time_ms: Date.now() - start };
    } catch {
      return { service: 'Redis', status: 'down', last_check: new Date().toISOString() };
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
