// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Metrics Endpoint Routes
 * Exposes the Prometheus metrics endpoint to the scraper holding METRICS_SCRAPE_TOKEN.
 */

import { createHash, timingSafeEqual } from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { getMetricsRegistry, logger } from '@cmdb/common';

/** Shorter tokens (and unset/empty) leave GET /metrics unanswered: the app's 404. */
export const MIN_SCRAPE_TOKEN_LENGTH = 32;

/**
 * GET /metrics - all metrics in Prometheus text format.
 *
 * Fail-closed in every NODE_ENV: no default token. Only `Authorization: Bearer
 * <token>` is accepted (no query string, API key or user JWT). Equal-length
 * SHA-256 digests are compared with timingSafeEqual, so neither the length nor
 * a prefix of the token leaks. Neither token nor collector error text is ever
 * logged or echoed. The token is read once; rotation needs a restart.
 */
export function createMetricsRoutes(token: string | undefined): Router {
  const router = Router();
  const enabled = token !== undefined && token.length >= MIN_SCRAPE_TOKEN_LENGTH;
  if (!enabled && token !== undefined && token !== '') {
    logger.warn(`METRICS_SCRAPE_TOKEN is shorter than ${MIN_SCRAPE_TOKEN_LENGTH} characters; /metrics is disabled`);
  }
  const expected = enabled ? createHash('sha256').update(token).digest() : null;

  router.get('/metrics', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!expected) {
      next();
      return;
    }
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!timingSafeEqual(createHash('sha256').update(presented).digest(), expected)) {
      res.set('WWW-Authenticate', 'Bearer').status(401).json({ _error: 'Unauthorized' });
      return;
    }
    try {
      const metricsRegistry = getMetricsRegistry();
      const metrics = await metricsRegistry.getMetrics();

      res.set('Content-Type', metricsRegistry.getContentType());
      res.send(metrics);
    } catch (error: unknown) {
      // Error class only: a collector message can carry connection details.
      logger.error('Failed to collect metrics', { errorName: error instanceof Error ? error.name : typeof error });
      res.status(500).json({ _error: 'Failed to collect metrics' });
    }
  });

  return router;
}
