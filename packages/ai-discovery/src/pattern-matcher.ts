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
import {
  DISCOVERY_HTTP_MAX_BYTES, DISCOVERY_HTTP_TOTAL_MS, DISCOVERY_RESPONSE_DEADLINE,
  DiscoveryHttpError, safeDiscoveryHttp,
} from './tools/safe-http';
import { detectWithPlan, parseDetectionPlan, parseDiscoveryPlan, PATTERN_NOT_ACTIVE, PATTERN_STATE_UNAVAILABLE, UNSUPPORTED_PATTERN_PLAN } from './pattern-plan';

/**
 * Budgets for ONE executeDiscovery call, across all of a pattern's endpoints (a plan may list 64,
 * each otherwise allowed 1 MiB / 15 s). Code constants: raising them is a reviewed change.
 *  - bytes: bytes the transport decoded, summed over the endpoints (`SafeDiscoveryHttpResponse.decodedBytes`,
 *    counted before JSON parsing: padding whitespace or duplicate keys cannot shrink the charge).
 *    A request that fails without a count (cut at its limit, reset or idle-timed-out mid-body, corrupt
 *    gzip, deadline) was decoded up to its limit at most, so it spends the limit it was requested with,
 *    whether the per-request ceiling or less. Only failures that cannot carry a body are free
 *    (NO_BODY_CODES: connection refused, host or network unreachable, name not found).
 *  - time: wall clock from the first request; each request's deadline is clipped to what is left.
 *  - stored: `Neo4jClient.createCI` stores `ci.metadata` as ONE leaf, `JSON.stringify(metadata)`, and
 *    the journal refuses a plan whose leaf JSON-encodes to more than PLAN_LIMITS.valueBytes (64 KiB)
 *    (HAP-443). So the bound is on the whole metadata, measured as that leaf, not per endpoint:
 *    one body is kept as received only if it is within DISCOVERY_STORED_BODY_MAX_BYTES of JSON and
 *    DISCOVERY_STORED_MAX_DEPTH levels deep; every body is cut (to a string ending in
 *    DISCOVERY_BODY_TRUNCATED) until the whole metadata leaf, with room reserved for the skipped and
 *    unstored endpoint lists below, is within DISCOVERY_STORED_METADATA_MAX_BYTES. A body that does
 *    not fit even as the marker alone is not stored and its endpoint is listed under
 *    `ci.metadata[DISCOVERY_UNSTORED_KEY]`. The 48 KiB limit leaves headroom under the 64 KiB leaf
 *    limit and keeps the plan, which carries the leaf twice (properties and audit change), far under
 *    its 1 MiB total.
 * Endpoints not requested once a budget is spent are listed under `ci.metadata[DISCOVERY_SKIPPED_KEY]`.
 * The base metadata (technology, category, scan version) is not budgeted here.
 */
export const DISCOVERY_PATTERN_MAX_TOTAL_BYTES = 4 * DISCOVERY_HTTP_MAX_BYTES;
/** Transport failure codes raised before any response byte can have arrived. */
const NO_BODY_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);
export const DISCOVERY_PATTERN_MAX_TOTAL_MS = 2 * DISCOVERY_HTTP_TOTAL_MS;
export const DISCOVERY_STORED_BODY_MAX_BYTES = 8192;
export const DISCOVERY_STORED_METADATA_MAX_BYTES = 48 * 1024;
/** Below PLAN_LIMITS.depth (32) in @cmdb/database, which counts the plan's own wrapper levels too. */
export const DISCOVERY_STORED_MAX_DEPTH = 16;
export const DISCOVERY_BODY_TRUNCATED = '... (truncated)';
/** Contain ':', which an endpoint key (validated `[a-zA-Z0-9/_.-]`) can never contain. */
export const DISCOVERY_SKIPPED_KEY = 'discovery:skipped';
export const DISCOVERY_UNSTORED_KEY = 'discovery:unstored';

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '');

/** Size of the leaf `createCI` stores for this metadata, measured the way the plan limit measures it. */
const leafBytes = (metadata: unknown): number => jsonBytes(JSON.stringify(metadata));

/** True when a container sits `max` or more levels down (so the value has more than `max` levels). */
function nestsDeeperThan(value: unknown, max: number, depth = 0): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (depth >= max) return true;
  return Object.values(value).some(member => nestsDeeperThan(member, max, depth + 1));
}

/** Bytes of the endpoint lists a finished call may add to the metadata (each endpoint is in at most one). */
function listsReserve(endpoints: string[]): number {
  return leafBytes({
    [DISCOVERY_SKIPPED_KEY]: { reason: 'bytes-budget', endpoints },
    [DISCOVERY_UNSTORED_KEY]: { reason: 'metadata-budget', endpoints: [] },
  });
}

/**
 * The value to keep under `key` in `metadata`: the body as received when it is small, shallow and
 * leaves the metadata leaf (plus `reserve`) within the metadata cap, else its text cut to fit (JSON
 * re-serialized for an object). Undefined when not even the cut marker fits.
 */
function storableBody(metadata: Record<string, unknown>, key: string, data: unknown, reserve: number): unknown {
  const cost = (value: unknown): number => leafBytes({ ...metadata, [key]: value }) + reserve;
  const small = jsonBytes(data) <= DISCOVERY_STORED_BODY_MAX_BYTES;
  if (small && !nestsDeeperThan(data, DISCOVERY_STORED_MAX_DEPTH) && cost(data) <= DISCOVERY_STORED_METADATA_MAX_BYTES) return data;
  if (small && typeof data === 'object' && data !== null) {
    // Only too deep: its JSON text loses nothing, so it carries no truncation marker.
    const text = JSON.stringify(data);
    if (jsonBytes(text) <= DISCOVERY_STORED_BODY_MAX_BYTES && cost(text) <= DISCOVERY_STORED_METADATA_MAX_BYTES) return text;
  }
  const markerOnly = cost(DISCOVERY_BODY_TRUNCATED);
  if (markerOnly > DISCOVERY_STORED_METADATA_MAX_BYTES) return undefined;
  const markerJson = jsonBytes(DISCOVERY_BODY_TRUNCATED);
  const text = Buffer.from(typeof data === 'string' ? data : (JSON.stringify(data) ?? ''));
  let keep = Math.min(text.length, DISCOVERY_STORED_BODY_MAX_BYTES);
  for (;;) {
    const cut = text.subarray(0, keep).toString('utf8') + DISCOVERY_BODY_TRUNCATED;
    const total = cost(cut);
    const own = jsonBytes(cut);
    if (total <= DISCOVERY_STORED_METADATA_MAX_BYTES && own <= DISCOVERY_STORED_BODY_MAX_BYTES) return cut;
    // JSON escapes and split characters make size nonlinear in `keep`: shrink in proportion, strictly, and retry.
    const ratio = Math.min(
      total <= DISCOVERY_STORED_METADATA_MAX_BYTES ? 1
        : (DISCOVERY_STORED_METADATA_MAX_BYTES - markerOnly) / (total - markerOnly),
      own <= DISCOVERY_STORED_BODY_MAX_BYTES ? 1
        : (DISCOVERY_STORED_BODY_MAX_BYTES - markerJson) / (own - markerJson));
    keep = Math.max(0, Math.min(keep - 1, Math.floor(keep * ratio)));
  }
}

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
    const started = Date.now();
    let bytesLeft = DISCOVERY_PATTERN_MAX_TOTAL_BYTES;
    let exhausted: 'bytes' | 'time' | undefined;
    const skipped: string[] = [];
    const unstored: string[] = [];
    const reserve = listsReserve(plan.endpoints);
    for (const endpoint of plan.endpoints) {
      const msLeft = DISCOVERY_PATTERN_MAX_TOTAL_MS - (Date.now() - started);
      if (!exhausted && bytesLeft <= 0) exhausted = 'bytes';
      if (!exhausted && msLeft <= 0) exhausted = 'time';
      if (exhausted) { skipped.push(endpoint); continue; }
      const limit = Math.min(bytesLeft, DISCOVERY_HTTP_MAX_BYTES);
      try {
        const response = await safeDiscoveryHttp(
          `${protocol}://${host}:${context.targetPort}${endpoint}`,
          { method: 'GET', timeout: 5000, validateStatus: () => true, maxContentLength: limit, totalMs: msLeft }
        );
        // Decoded bytes from the transport: the parsed value can be much smaller than what was inflated.
        bytesLeft -= response.decodedBytes;
        if (response.status >= 200 && response.status < 300) {
          const key = endpoint.slice(1);
          let stored: unknown;
          try {
            stored = storableBody(ci.metadata, key, response.data, reserve);
          } catch {
            // A body too deeply nested to re-serialize (JSON.parse accepts what JSON.stringify cannot).
            stored = undefined;
          }
          if (stored === undefined) unstored.push(endpoint); else ci.metadata[key] = stored;
        }
      } catch (error) {
        if (error instanceof Error && error.message === DISCOVERY_TARGET_REFUSED) throw error;
        // A failure after the body started (cut at the limit, reset, idle timeout, bad gzip trailer,
        // deadline) reports no byte count, yet the transport may have decoded up to `limit`: it spends
        // `limit`. Only failures that cannot come with a body are free.
        if (!(error instanceof DiscoveryHttpError && error.code !== undefined && NO_BODY_CODES.has(error.code))) {
          bytesLeft -= limit;
        }
        if (error instanceof Error && error.message === DISCOVERY_RESPONSE_DEADLINE &&
          msLeft < DISCOVERY_HTTP_TOTAL_MS) exhausted = 'time';
        // An unavailable public endpoint does not discard the discovered CI.
      }
    }
    if (skipped.length) {
      ci.metadata[DISCOVERY_SKIPPED_KEY] = { reason: `${exhausted}-budget`, endpoints: skipped };
    }
    if (unstored.length) {
      ci.metadata[DISCOVERY_UNSTORED_KEY] = { reason: 'metadata-budget', endpoints: unstored };
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
