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
 * - Graceful degradation if Redis is unavailable
 */

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
  limit(endpointType: keyof ConfigSchema['rateLimit']['endpoints']) {
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

      const identifier = this.getIdentifier(req);
      const key = `rate-limit:${endpointType}:${identifier}`;

      try {
        const result = await this.checkRateLimit(key, {
          _max: effectiveMax,
          _windowMs: endpointConfig.windowMs,
        });

        // Set rate limit headers
        this.setRateLimitHeaders(res, result);

        if (!result._allowed) {
          // Increment metrics
          if (this.metricsEnabled) {
            this.incrementMetric(`${endpointType}:${this.getUserTier(req)}`);
          }

          // Log rate limit hit
          if (this.config.monitoring.logRateLimitHits) {
            logger.warn('Rate limit exceeded', {
              endpoint: endpointType,
              identifier,
              limit: result._limit,
              resetAt: new Date(result._resetAt).toISOString(),
            });
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
        // If Redis fails, allow request but log error (graceful degradation)
        logger.error(
          'Rate limit check failed - allowing request',
          error instanceof Error ? error : new Error(String(error))
        );
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
   * Get client IP address (handles proxies and load balancers)
   */
  private getClientIp(req: Request): string {
    // Check X-Forwarded-For header (comma-separated list, first is client)
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      return ips?.split(',')[0]?.trim() || 'unknown';
    }

    // Check X-Real-IP header
    const realIp = req.headers['x-real-ip'];
    if (realIp) {
      return (Array.isArray(realIp) ? realIp[0] : realIp) || 'unknown';
    }

    // Fall back to socket address
    return req.socket.remoteAddress || 'unknown';
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
