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
import { detectWithPlan, parseDetectionPlan, parseDiscoveryPlan, PATTERN_NOT_ACTIVE, PATTERN_STATE_UNAVAILABLE, UNSUPPORTED_PATTERN_PLAN } from './pattern-plan';

/** Length framing makes concatenated IDs and plan bodies unambiguous to the hash. */
function hashField(hash: crypto.Hash, value: string): void {
  hash.update(String(value.length)).update(':').update(value);
}

export class PatternMatcher implements IPatternMatcher {
  private patternStorage: PatternStorageService;
  private patterns: DiscoveryPattern[] = [];
  private redis = getRedisClient();
  private readonly MATCH_CACHE_PREFIX = 'ai:pattern:match:v2:';
  private readonly MATCH_CACHE_TTL = 300; // 5 minutes

  constructor(patternStorage?: PatternStorageService) {
    this.patternStorage = patternStorage || new PatternStorageService();
  }

  /** A failed refresh never authorizes execution using a process-local snapshot. */
  private async refreshActivePatterns(): Promise<DiscoveryPattern[]> {
    try {
      const patterns = await this.patternStorage.loadPatterns(true);
      this.patterns = patterns;
      return patterns;
    } catch {
      throw new Error(PATTERN_STATE_UNAVAILABLE);
    }
  }

  async loadPatterns(): Promise<void> {
    await this.refreshActivePatterns();
  }

  /** Include the exact active plan set; a changed or revoked plan cannot reuse a cached match. */
  private createActiveSetHash(patterns: DiscoveryPattern[]): string {
    const hash = crypto.createHash('sha256');
    for (const pattern of patterns) {
      hashField(hash, pattern.patternId);
      hashField(hash, pattern.version);
      hashField(hash, pattern.detectionCode);
      hashField(hash, pattern.discoveryCode);
    }
    return hash.digest('hex');
  }

  private createCacheKey(scanResult: any, activeSetHash: string): string {
    const hash = crypto.createHash('sha256').update(JSON.stringify(scanResult)).digest('hex');
    return `${this.MATCH_CACHE_PREFIX}${activeSetHash}:${hash}`;
  }

  /**
   * Match scan result against patterns with caching
   */
  async match(scanResult: any): Promise<PatternMatch | null> {
    // Redis's active-list cache is invalidated on each committed mutation.
    // Never trust a process-local snapshot at a new match boundary.
    const patterns = await this.refreshActivePatterns();
    // Validate both bodies before cached null/hit can bypass a refusal. Reuse
    // parsed detection plans on a cache miss instead of parsing them twice.
    const detectionPlans = patterns.map(pattern => {
      const plan = parseDetectionPlan(pattern.detectionCode);
      parseDiscoveryPlan(pattern.discoveryCode);
      return plan;
    });

    // Check cache first
    const activeSetHash = this.createActiveSetHash(patterns);
    const cacheKey = this.createCacheKey(scanResult, activeSetHash);
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
      patternCount: patterns.length,
    });

    for (let index = 0; index < patterns.length; index++) {
      const pattern = patterns[index]!;
      const result = detectWithPlan(detectionPlans[index]!, scanResult);
      if (result.matches && result.confidence > bestConfidence) {
        bestConfidence = result.confidence;
        bestMatch = {
          patternId: pattern.patternId,
          patternVersion: pattern.version,
          confidence: result.confidence,
          matchedIndicators: result.indicators || [],
          activeSetHash,
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


  /**
   * Execute matched pattern for discovery
   */
  async executePattern(
    patternId: string,
    context: AIDiscoveryContext,
    expectedActiveSetHash?: string
  ): Promise<any[]> {
    const startTime = Date.now();
    const sessionId = `pattern-exec-${crypto.randomUUID()}`;

    try {
      const patterns = await this.refreshActivePatterns();
      if (expectedActiveSetHash !== undefined &&
        expectedActiveSetHash !== this.createActiveSetHash(patterns)) {
        throw new Error(PATTERN_NOT_ACTIVE);
      }
      const pattern = patterns.find(p => p.patternId === patternId);
      if (!pattern) throw new Error(PATTERN_NOT_ACTIVE);

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
