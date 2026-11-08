// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Production-Grade Rate Limiting Middleware
 *
 * Features:
 * - Redis-backed distributed rate limiting with sliding window algorithm
 * - Tier-based rate limiting (anonymous, standard, premium, enterprise)
 * - Per-endpoint rate limit configuration
 * - Internal service bypass mechanism
 * - Comprehensive rate limit headers (X-RateLimit-*)
 * - Monitoring and metrics for rate limit hits
 * - Graceful degradation if Redis is unavailable (fail-closed limiters, POST /auth/login, answer 503 instead)
 * - Client identity is req.ip only: Express `trust proxy` (TRUST_PROXY) decides which forwarded hops count
 */

import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';
import type { ConfigSchema } from '@cmdb/common';
import { getLogger } from '@cmdb/common';
import { AuthenticatedRequest } from './auth.middleware';

const logger = getLogger();

export interface RateLimitConfig {
  _max: number;
  _windowMs: number;
}

export interface RateLimitResult {
  _allowed: boolean;
  _remaining: number;
  _resetAt: number;
  _limit: number;
}

export interface LimitOptions {
  /** Also limits per account + client at endpoints.authAccount; returns the raw account name (HAP-1091). */
  account?: (req: Request) => unknown;
  /** A limiter store error answers 503 instead of passing the request through. */
  failClosed?: boolean;
}

export class RateLimitMiddleware {
  private redis: Redis;
  private config: ConfigSchema['rateLimit'];
  private metricsEnabled: boolean;
  private rateLimitHits: Map<string, number> = new Map();

  constructor(redis: Redis, config: ConfigSchema['rateLimit']) {
    this.redis = redis;
    this.config = config;
    this.metricsEnabled = config.monitoring.enabled;

    // Periodically log rate limit metrics
    if (this.metricsEnabled && config.monitoring.logRateLimitHits) {
      setInterval(() => this.logMetrics(), 60000); // Every minute
    }
  }

  /**
   * Create rate limiter for specific endpoint
   */
  limit(endpointType: keyof ConfigSchema['rateLimit']['endpoints'], options: LimitOptions = {}) {
    return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      if (!this.config.enabled) {
        return next();
      }

      // Check for internal service bypass
      if (this.checkBypass(req)) {
        logger.debug('Rate limit bypassed for internal service', {
          endpoint: endpointType,
          ip: this.getClientIp(req),
        });
        return next();
      }

      const endpointConfig = this.config.endpoints[endpointType];

      // Skip rate limiting for unlimited endpoints (e.g., health checks)
      if (endpointConfig.max === 0) {
        return next();
      }

      // Calculate effective rate limit based on user tier
      const tierMultiplier = this.getTierMultiplier(req);
      const effectiveMax = endpointConfig.max * tierMultiplier;

      const budget = { _max: effectiveMax, _windowMs: endpointConfig.windowMs };
      try {
        if (await this.admit(req, res, endpointType, budget, options)) {
          next();
        }
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        if (options.failClosed === true) {
          logger.error('Rate limit check failed - refusing request (fail closed)', cause);
          res.status(503).json({
            _error: 'Service Unavailable',
            _message: 'Rate limiting is unavailable. Try again later',
          });
          return;
        }
        // If Redis fails, allow request but log error (graceful degradation)
        logger.error('Rate limit check failed - allowing request', cause);
        next();
      }
    };
  }

  /**
   * The configured budget of an endpoint type, for custom() under another key (HAP-1211 H2 ruling A: refresh uses
   * the REST budget). A max of 0 means unlimited, as in limit(); custom() does not apply that rule, so callers skip it.
   */
  endpointBudget(endpointType: keyof ConfigSchema['rateLimit']['endpoints']): RateLimitConfig {
    const { max, windowMs } = this.config.endpoints[endpointType];
    return { _max: max, _windowMs: windowMs };
  }

  /**
   * Create custom rate limiter with specific config
   */
  custom(config: RateLimitConfig, keyPrefix = 'custom') {
    return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      if (!this.config.enabled) {
        return next();
      }

      if (this.checkBypass(req)) {
        return next();
      }

      const identifier = this.getIdentifier(req);
      const key = `rate-limit:${keyPrefix}:${identifier}`;

      try {
        const result = await this.checkRateLimit(key, config);

        this.setRateLimitHeaders(res, result);

        if (!result._allowed) {
          if (this.metricsEnabled) {
            this.incrementMetric(`${keyPrefix}:custom`);
          }

          return res.status(429).json({
            _error: 'Too Many Requests',
            _message: `Rate limit exceeded. Try again in ${Math.ceil((result._resetAt - Date.now()) / 1000)} seconds`,
            _retryAfter: Math.ceil((result._resetAt - Date.now()) / 1000),
            _limit: result._limit,
            _resetAt: new Date(result._resetAt).toISOString(),
          });
        }

        next();
      } catch (error) {
        logger.error(
          'Rate limit check failed - allowing request',
          error instanceof Error ? error : new Error(String(error))
        );
        next();
      }
    };
  }

  /**
   * Check rate limit using sliding window algorithm with Redis
   */
  private async checkRateLimit(
    key: string,
    config: RateLimitConfig
  ): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - config._windowMs;

    // Redis pipeline for atomic operations
    const pipeline = this.redis.pipeline();

    // Remove old entries outside the window
    pipeline.zremrangebyscore(key, '-inf', windowStart.toString());

    // Count current requests in window
    pipeline.zcard(key);

    // Add current request with timestamp as score
    pipeline.zadd(key, now.toString(), `${now}-${Math.random()}`);

    // Set expiration on the key
    pipeline.expire(key, Math.ceil(config._windowMs / 1000));

    const results = await pipeline.exec();

    if (!results) {
      throw new Error('Redis pipeline failed');
    }
    // HAP-1091: ioredis resolves exec() with a per-command [error, reply] (e.g. a connection lost after the retries);
    // a failed command is a store error, never a count of 0.
    const failed = results.find(([error]) => error !== null);
    if (failed !== undefined) {
      throw failed[0];
    }

    // Get count before adding current request (index 1)
    const count = (results[1]?.[1] as number) || 0;

    const allowed = count < config._max;
    const remaining = Math.max(0, config._max - count - 1);

    // Calculate reset time (end of current window)
    const resetAt = now + config._windowMs;

    return {
      _allowed: allowed,
      _remaining: remaining,
      _resetAt: resetAt,
      _limit: config._max,
    };
  }

  /**
   * Set rate limit response headers
   */
  private setRateLimitHeaders(res: Response, result: RateLimitResult): void {
    res.setHeader('X-RateLimit-Limit', result._limit.toString());
    res.setHeader('X-RateLimit-Remaining', result._remaining.toString());
    res.setHeader('X-RateLimit-Reset', result._resetAt.toString());
  }

  /**
   * Check if request should bypass rate limiting (internal services)
   */
  private checkBypass(req: Request): boolean {
    if (!this.config.bypassSecret) {
      return false;
    }

    const bypassHeader = req.headers[this.config.bypassHeader.toLowerCase()] as string | undefined;
    return bypassHeader === this.config.bypassSecret;
  }

  /**
   * Get tier multiplier for rate limits based on user authentication
   */
  private getTierMultiplier(req: AuthenticatedRequest): number {
    if (!req.user) {
      return 1; // Anonymous users get base rate limit
    }

    const tier = req.user._tier || 'standard';
    return this.config.tierMultipliers[tier] || 1;
  }

  /**
   * Get user tier for metrics
   */
  private getUserTier(req: AuthenticatedRequest): string {
    if (!req.user) {
      return 'anonymous';
    }
    return req.user._tier || 'standard';
  }

  /**
   * Get identifier for rate limiting (user ID or IP)
   */
  private getIdentifier(req: AuthenticatedRequest): string {
    // Prefer user ID if authenticated
    if (req.user?._userId) {
      return `user:${req.user._userId}`;
    }

    // Fall back to IP address
    const ip = this.getClientIp(req);
    return `ip:${ip}`;
  }

  /**
   * Checks the client bucket, then (with options.account) the account+client bucket; answers 429 and returns false
   * on the first one exhausted. A denied client bucket leaves the account+client bucket untouched.
   */
  private async admit(
    req: AuthenticatedRequest,
    res: Response,
    endpointType: keyof ConfigSchema['rateLimit']['endpoints'],
    budget: RateLimitConfig,
    options: LimitOptions
  ): Promise<boolean> {
    const identifier = this.getIdentifier(req);
    const buckets = [{ key: `rate-limit:${endpointType}:${identifier}`, identifier, budget }];
    const account = options.account?.(req);
    if (typeof account === 'string' && account.trim() !== '') {
      // HAP-1091: the username is stored only as an unsalted sha256 (not plain text in keys or logs); keyed with the
      // client, so nobody can lock another client's login out of an account.
      const digest = createHash('sha256').update(account.trim().toLowerCase()).digest('hex');
      const { max, windowMs } = this.config.endpoints.authAccount;
      buckets.push({
        key: `rate-limit:${endpointType}-account:${digest}:${identifier}`,
        identifier: `account:${digest}:${identifier}`,
        budget: { _max: max, _windowMs: windowMs },
      });
    }

    for (const bucket of buckets) {
      const result = await this.checkRateLimit(bucket.key, bucket.budget);
      this.setRateLimitHeaders(res, result);
      if (result._allowed) {
        continue;
      }

      // Increment metrics
      if (this.metricsEnabled) {
        this.incrementMetric(`${endpointType}:${this.getUserTier(req)}`);
      }

      // Log rate limit hit
      if (this.config.monitoring.logRateLimitHits) {
        logger.warn('Rate limit exceeded', {
          endpoint: endpointType,
          identifier: bucket.identifier,
          limit: result._limit,
          resetAt: new Date(result._resetAt).toISOString(),
        });
      }

      res.status(429).json({
        _error: 'Too Many Requests',
        _message: `Rate limit exceeded. Try again in ${Math.ceil((result._resetAt - Date.now()) / 1000)} seconds`,
        _retryAfter: Math.ceil((result._resetAt - Date.now()) / 1000),
        _limit: result._limit,
        _resetAt: new Date(result._resetAt).toISOString(),
      });
      return false;
    }
    return true;
  }

  /**
   * Get client IP address: req.ip, which Express derives from X-Forwarded-For only for the hops TRUST_PROXY trusts
   * (HAP-1091). A raw X-Forwarded-For / X-Real-IP is client-controlled and never read here.
   */
  private getClientIp(req: Request): string {
    return req.ip ?? req.socket.remoteAddress ?? 'unknown';
  }

  /**
   * Increment metrics counter
   */
  private incrementMetric(key: string): void {
    const current = this.rateLimitHits.get(key) || 0;
    this.rateLimitHits.set(key, current + 1);
  }

  /**
   * Log rate limit metrics
   */
  private logMetrics(): void {
    if (this.rateLimitHits.size === 0) {
      return;
    }

    const metrics: Record<string, number> = {};
    this.rateLimitHits.forEach((count, key) => {
      metrics[key] = count;
    });

    logger.info('Rate limit metrics', { metrics });

    // Reset counters
    this.rateLimitHits.clear();
  }

  /**
   * Get current metrics (for monitoring endpoints)
   */
  public getMetrics(): Record<string, number> {
    const metrics: Record<string, number> = {};
    this.rateLimitHits.forEach((count, key) => {
      metrics[key] = count;
    });
    return metrics;
  }
}

/**
 * Create rate limit middleware instance
 */
export function createRateLimitMiddleware(
  redis: Redis,
  config: ConfigSchema['rateLimit']
): RateLimitMiddleware {
  return new RateLimitMiddleware(redis, config);
}
