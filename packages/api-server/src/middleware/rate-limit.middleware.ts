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
 * - Graceful degradation if Redis is unavailable (fail-closed limiters, POST /auth/login and PUT /auth/password, answer
 *   a fixed 503 with Cache-Control: no-store instead; the refresh limiter and other fail-open limiters let it through)
 * - Client identity is req.ip only: Express `trust proxy` (TRUST_PROXY) decides which forwarded hops count
 * - A store error is logged by class and code only, never its message (HAP-1764, the HAP-1382 pattern)
 */

import { createHash } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';
import type { ConfigSchema } from '@cmdb/common';
import { getLogger } from '@cmdb/common';
import { AuthenticatedRequest } from './auth.middleware';
import { errorClassFields } from '../utils/log-error';

const logger = getLogger();

/** HAP-1764: the fixed body of a fail-closed limiter whose store failed; never the store's error text. */
const RATE_LIMIT_UNAVAILABLE = Object.freeze({
  _error: 'Service Unavailable',
  _message: 'Rate limiting is unavailable. Try again later',
});

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
  /**
   * Also limits per account + client at endpoints.authAccount (HAP-1091) and per account across all clients at
   * endpoints.authAccountGlobal (HAP-1764); returns the raw account name, normalized here (trimmed, lowercased).
   */
  account?: (req: Request) => unknown;
  /** A limiter store error answers a fixed 503 (no-store) instead of passing the request through. */
  failClosed?: boolean;
  /**
   * HAP-1368 (authenticated credential checks): the client bucket keys on req.ip even for a signed-in caller, plus
   * a bucket for the verified user across all clients at endpoints.authAccount; both at the base budget (no tier).
   */
  perUser?: boolean;
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

      // Calculate effective rate limit based on user tier; a per-user credential check keeps login's base budget
      const tierMultiplier = options.perUser === true ? 1 : this.getTierMultiplier(req);
      const effectiveMax = endpointConfig.max * tierMultiplier;

      const budget = { _max: effectiveMax, _windowMs: endpointConfig.windowMs };
      try {
        if (await this.admit(req, res, endpointType, budget, options)) {
          next();
        }
      } catch (error) {
        if (options.failClosed === true) {
          // A fixed refusal: admit() sets no X-RateLimit-* before every bucket answered, and the store error stays out.
          logger.error('Rate limit check failed - refusing request (fail closed)', undefined, {
            endpoint: endpointType,
            ...errorClassFields(error),
          });
          res.set('Cache-Control', 'no-store');
          res.status(503).json(RATE_LIMIT_UNAVAILABLE);
          return;
        }
        // If Redis fails, allow request but log error (graceful degradation)
        logger.error('Rate limit check failed - allowing request', undefined, {
          endpoint: endpointType,
          ...errorClassFields(error),
        });
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
        logger.error('Rate limit check failed - allowing request', undefined, {
          endpoint: keyPrefix,
          ...errorClassFields(error),
        });
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
   * Checks the client bucket, then (with options.account) the account+client and account-across-clients buckets, or
   * (with options.perUser) the user bucket; answers 429 and returns false on the first one exhausted. A denied
   * bucket leaves the later ones untouched.
   *
   * HAP-1795: only the client bucket (the first) is ever reported. A later bucket counts attempts at an account, the
   * account-wide ones from every client, so its count, limit or reset must never reach the caller: X-RateLimit-* and
   * every 429 body come from the client bucket, and a refusal by a later bucket reads exactly like the client
   * bucket's own (Remaining 0). Headers are set only after every bucket answered, so a store error on a later bucket
   * leaves none for the fail-closed 503.
   */
  private async admit(
    req: AuthenticatedRequest,
    res: Response,
    endpointType: keyof ConfigSchema['rateLimit']['endpoints'],
    budget: RateLimitConfig,
    options: LimitOptions
  ): Promise<boolean> {
    const identifier = options.perUser === true ? `ip:${this.getClientIp(req)}` : this.getIdentifier(req);
    const buckets = [{ key: `rate-limit:${endpointType}:${identifier}`, identifier, budget }];
    const account = options.account?.(req);
    const { max, windowMs } = this.config.endpoints.authAccount;
    if (typeof account === 'string' && account.trim() !== '') {
      // HAP-1091: the username is stored only as an unsalted sha256 (not plain text in keys or logs); keyed with the
      // client, so one client exhausts its own tries at an account long before the account-wide bucket below.
      const digest = createHash('sha256').update(account.trim().toLowerCase()).digest('hex');
      buckets.push({
        key: `rate-limit:${endpointType}-account:${digest}:${identifier}`,
        identifier: `account:${digest}:${identifier}`,
        budget: { _max: max, _windowMs: windowMs },
      });
      // HAP-1764: the account across every client address, so many addresses cannot each spend a full account+client
      // budget on one account. Its cost: that many attempts from anywhere refuse the account's logins (429) for the
      // window, the legitimate user's included. max 0 turns it off.
      const global = this.config.endpoints.authAccountGlobal;
      if (global.max > 0) {
        buckets.push({
          key: `rate-limit:${endpointType}-account-global:${digest}`,
          identifier: `account-global:${digest}`,
          budget: { _max: global.max, _windowMs: global.windowMs },
        });
      }
    }
    if (options.perUser === true) {
      // HAP-1368: not keyed by client, so another address cannot reset it; only a holder of the user's verified
      // session can spend it. Mounted after authentication; a missing user throws, which failClosed answers with 503.
      const userId = req.user?._userId;
      if (!userId) throw new Error('perUser limiter reached without a verified user');
      buckets.push({
        key: `rate-limit:${endpointType}-user:${userId}`,
        identifier: `user:${userId}`,
        budget: { _max: max, _windowMs: windowMs },
      });
    }

    let client: RateLimitResult | undefined;
    for (const bucket of buckets) {
      const result = await this.checkRateLimit(bucket.key, bucket.budget);
      client ??= result;
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

      const reported = { ...client, _remaining: 0 };
      this.setRateLimitHeaders(res, reported);
      res.status(429).json({
        _error: 'Too Many Requests',
        _message: `Rate limit exceeded. Try again in ${Math.ceil((reported._resetAt - Date.now()) / 1000)} seconds`,
        _retryAfter: Math.ceil((reported._resetAt - Date.now()) / 1000),
        _limit: reported._limit,
        _resetAt: new Date(reported._resetAt).toISOString(),
      });
      return false;
    }
    if (client !== undefined) {
      this.setRateLimitHeaders(res, client);
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
