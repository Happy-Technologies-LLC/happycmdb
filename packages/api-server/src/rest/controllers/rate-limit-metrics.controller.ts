// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Rate Limit Metrics Controller
 * Provides monitoring endpoints for rate limiting statistics
 */

import { Request, Response } from 'express';
import { RateLimitMiddleware } from '../../middleware/rate-limit.middleware';
import { getLogger } from '@cmdb/common';

const logger = getLogger();

export class RateLimitMetricsController {
  private rateLimitMiddleware: RateLimitMiddleware;

  constructor(rateLimitMiddleware: RateLimitMiddleware) {
    this.rateLimitMiddleware = rateLimitMiddleware;
  }

  /**
   * Get current rate limit metrics
   * GET /api/v1/metrics/rate-limits
   */
  public getMetrics = async (_req: Request, res: Response): Promise<void> => {
    try {
      const metrics = this.rateLimitMiddleware.getMetrics();

      // Calculate totals by endpoint and tier
      const byEndpoint: Record<string, number> = {};
      const byTier: Record<string, number> = {};
      let totalHits = 0;

      Object.entries(metrics).forEach(([key, count]) => {
        const parts = key.split(':');
        const endpoint = parts[0];
        const tier = parts[1];

        // Aggregate by endpoint
        if (endpoint) {
          if (!byEndpoint[endpoint]) {
            byEndpoint[endpoint] = 0;
          }
          byEndpoint[endpoint] += count;
        }

        // Aggregate by tier
        if (tier) {
          if (!byTier[tier]) {
            byTier[tier] = 0;
          }
          byTier[tier] += count;
        }

        totalHits += count;
      });

      res.json({
        success: true,
        data: {
          totalRateLimitHits: totalHits,
          byEndpoint,
          byTier,
          detailed: metrics,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error(
        'Failed to retrieve rate limit metrics',
        error instanceof Error ? error : new Error(String(error))
      );
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to retrieve rate limit metrics',
      });
    }
  };

  /**
   * Get rate limit configuration
   * GET /api/v1/metrics/rate-limits/config
   */
  public getConfiguration = async (_req: Request, res: Response): Promise<void> => {
    try {
      // This would ideally come from the config service
      // For now, return a summary of the configuration
      res.json({
        success: true,
        data: {
          message: 'Rate limit configuration summary',
          note: 'Use environment variables or config files to view full configuration',
          endpoints: {
            rest: 'Base: 1000 req/hour (anonymous)',
            graphql: 'Base: 500 req/hour (anonymous)',
            health: 'Unlimited',
            auth: 'Base: 20 req/hour (anonymous)',
            discovery: 'Base: 100 req/hour',
            admin: 'Base: 200 req/hour',
          },
          tiers: {
            standard: '5x multiplier',
            premium: '10x multiplier',
            enterprise: '20x multiplier',
          },
        },
      });
    } catch (error) {
      logger.error(
        'Failed to retrieve rate limit configuration',
        error instanceof Error ? error : new Error(String(error))
      );
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to retrieve rate limit configuration',
      });
    }
  };
}
