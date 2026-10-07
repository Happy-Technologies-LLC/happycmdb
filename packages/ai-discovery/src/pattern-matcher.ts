// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Pattern Matcher
 * Executes pre-compiled discovery patterns for fast detection with caching
 */

import { DiscoveryPattern, PatternMatch, AIDiscoveryContext, IPatternMatcher } from './types';
import { PatternStorageService } from './pattern-storage';
import { DISCOVERY_TARGET_REFUSED, logger, resolveDiscoveryHost } from '@cmdb/common';
import { getRedisClient } from '@cmdb/database';
import * as crypto from 'crypto';
import { safeDiscoveryHttp } from './tools/safe-http';
import { detectWithPlan, parseDetectionPlan, parseDiscoveryPlan, UNSUPPORTED_PATTERN_PLAN } from './pattern-plan';

export class PatternMatcher implements IPatternMatcher {
  private patternStorage: PatternStorageService;
  private patterns: DiscoveryPattern[] = [];
  private redis = getRedisClient();
  private readonly MATCH_CACHE_PREFIX = 'ai:pattern:match:';
  private readonly MATCH_CACHE_TTL = 300; // 5 minutes

  constructor(patternStorage?: PatternStorageService) {
    this.patternStorage = patternStorage || new PatternStorageService();
  }

  /**
   * Load patterns from storage
   */
  async loadPatterns(): Promise<void> {
    this.patterns = await this.patternStorage.loadPatterns();
    logger.info(`Pattern matcher loaded ${this.patterns.length} patterns`);
  }

  /**
   * Create cache key from scan result
   */
  private createCacheKey(scanResult: any): string {
    // Create deterministic hash of scan result
    const data = JSON.stringify(scanResult);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    return `${this.MATCH_CACHE_PREFIX}${hash}`;
  }

  /**
   * Match scan result against patterns with caching
   */
  async match(scanResult: any): Promise<PatternMatch | null> {
    if (this.patterns.length === 0) {
      await this.loadPatterns();
    }

    // Check cache first
    const cacheKey = this.createCacheKey(scanResult);
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const match = JSON.parse(cached);
        logger.debug('Pattern match loaded from cache', { patternId: match?.patternId });
        return match;
      }
    } catch (error) {
      // Cache miss or error - continue with matching
      logger.debug('Cache miss for pattern match', { error });
    }

    let bestMatch: PatternMatch | null = null;
    let bestConfidence = 0;

    logger.debug('Matching scan result against patterns', {
      patternCount: this.patterns.length,
    });

    for (const pattern of this.patterns) {
      // Legacy code fails explicitly; never cache it as a negative match.
      const result = this.executeDetection(pattern, scanResult);
      if (result.matches && result.confidence > bestConfidence) {
        bestConfidence = result.confidence;
        bestMatch = {
          patternId: pattern.patternId,
          patternVersion: pattern.version,
          confidence: result.confidence,
          matchedIndicators: result.indicators || [],
        };
        logger.debug('Pattern matched', {
          patternId: pattern.patternId,
          confidence: result.confidence,
          indicators: result.indicators,
        });
      }
    }

    if (bestMatch) {
      logger.info('Best pattern match found', {
        patternId: bestMatch.patternId,
        confidence: bestMatch.confidence,
      });
    } else {
      logger.debug('No pattern matches found');
    }

    // Cache the result (even null results to avoid re-scanning)
    try {
      await this.redis.setex(
        cacheKey,
        this.MATCH_CACHE_TTL,
        JSON.stringify(bestMatch)
      );
    } catch (error) {
      logger.error('Failed to cache pattern match', { error });
      // Don't throw - caching is optional
    }

    return bestMatch;
  }

  /** Detection is fixed interpreter logic over validated JSON data. */
  private executeDetection(
    pattern: DiscoveryPattern,
    scanResult: any
  ): { matches: boolean; confidence: number; indicators?: string[] } {
    return detectWithPlan(parseDetectionPlan(pattern.detectionCode), scanResult);
  }

  /**
   * Execute matched pattern for discovery
   */
  async executePattern(
    patternId: string,
    context: AIDiscoveryContext
  ): Promise<any[]> {
    const startTime = Date.now();
    const sessionId = `pattern-exec-${crypto.randomUUID()}`;

    try {
      const pattern = this.patterns.find(p => p.patternId === patternId);
      if (!pattern) {
        throw new Error(`Pattern not found: ${patternId}`);
      }

      logger.info('Executing pattern', { patternId });

      // Execute discovery function
      const result = await this.executeDiscovery(pattern, context);

      const executionTime = Date.now() - startTime;

      // Record successful usage. ai_pattern_usage.session_id has a NOT NULL
      // foreign key into ai_discovery_sessions, so the backing session row
      // must be created first or the usage insert violates the constraint.
      await this.recordExecutionTelemetry(
        sessionId,
        patternId,
        context,
        true,
        executionTime,
        result
      );

      logger.info('Pattern executed successfully', {
        patternId,
        discovered: result.length,
        executionTime,
      });

      return result;
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Record failed usage
      await this.recordExecutionTelemetry(
        sessionId,
        patternId,
        context,
        false,
        executionTime,
        undefined,
        errorMessage
      );

      logger.error('Pattern execution failed', { patternId, error: errorMessage });
      throw error;
    }
  }

  /**
   * Persist the discovery session and usage row backing a pattern execution.
   * Telemetry failures are logged (never silently dropped) but never mask
   * or replace the actual discovery outcome being returned/thrown above.
   */
  private async recordExecutionTelemetry(
    sessionId: string,
    patternId: string,
    context: AIDiscoveryContext,
    success: boolean,
    executionTimeMs: number,
    discoveredCIs?: unknown[],
    errorMessage?: string
  ): Promise<void> {
    try {
      await this.patternStorage.createExecutionSession(
        sessionId,
        patternId,
        context,
        success ? 'completed' : 'failed',
        executionTimeMs,
        discoveredCIs,
        errorMessage
      );

      await this.patternStorage.recordUsage(
        patternId,
        sessionId,
        success,
        executionTimeMs,
        undefined,
        errorMessage
      );
    } catch (telemetryError) {
      logger.error('Failed to persist pattern execution telemetry', {
        patternId,
        sessionId,
        error:
          telemetryError instanceof Error
            ? telemetryError.message
            : String(telemetryError),
      });
    }
  }

  /** No host-realm functions or objects are exposed to stored pattern text. */
  private async executeDiscovery(
    pattern: DiscoveryPattern,
    context: AIDiscoveryContext
  ): Promise<any[]> {
    // Require both plans: a legacy detection body is not allowed to accompany a
    // declarative discovery body (or vice versa).
    parseDetectionPlan(pattern.detectionCode);
    const plan = parseDiscoveryPlan(pattern.discoveryCode);
    if (!Number.isInteger(context.targetPort) || context.targetPort < 1 || context.targetPort > 65535) {
      throw new Error(UNSUPPORTED_PATTERN_PLAN);
    }
    await resolveDiscoveryHost(context.targetHost);
    const ci: any = {
      _type: plan.serviceType,
      name: `${plan.name} on ${context.targetHost}:${context.targetPort}`,
      hostname: context.targetHost,
      port: context.targetPort,
      metadata: { technology: plan.name, category: plan.category },
    };
    const version = context.scanResult?.services?.[0]?.version;
    if (version) ci.metadata.version = version;
    const host = context.targetHost.includes(':') ? `[${context.targetHost}]` : context.targetHost;
    const protocol = context.targetPort === 443 ? 'https' : 'http';
    for (const endpoint of plan.endpoints) {
      try {
        const response = await safeDiscoveryHttp(
          `${protocol}://${host}:${context.targetPort}${endpoint}`,
          { method: 'GET', timeout: 5000, validateStatus: () => true }
        );
        if (response.status >= 200 && response.status < 300) {
          ci.metadata[endpoint.slice(1)] = response.data;
        }
      } catch (error) {
        if (error instanceof Error && error.message === DISCOVERY_TARGET_REFUSED) throw error;
        // An unavailable public endpoint does not discard the discovered CI.
      }
    }
    return [ci];
  }

  /**
   * Add new pattern (and reload)
   */
  async addPattern(pattern: DiscoveryPattern): Promise<void> {
    await this.patternStorage.savePattern(pattern);
    await this.loadPatterns(); // Reload all patterns
    logger.info('Pattern added and reloaded', { patternId: pattern.patternId });
  }

  /**
   * Get all loaded patterns
   */
  getPatterns(): DiscoveryPattern[] {
    return this.patterns;
  }
}
