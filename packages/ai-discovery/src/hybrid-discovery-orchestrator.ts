// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Hybrid Discovery Orchestrator
 * Routes discovery through three tiers: Pattern → AI → Legacy
 */

import { AIAgentCoordinator } from './ai-agent-coordinator';
import { PatternMatcher } from './pattern-matcher';
import { PatternStorageService } from './pattern-storage';
import {
  AIDiscoveryContext,
  AIDiscoveryResult,
  LLMConfig,
  PatternMatch,
} from './types';
import { DISCOVERY_TARGET_REFUSED, logger, resolveDiscoveryHost } from '@cmdb/common';
import { getDefaultLLMConfig } from './providers';
import { PATTERN_NOT_ACTIVE, PATTERN_STATE_UNAVAILABLE, UNSUPPORTED_PATTERN_PLAN } from './pattern-plan';

export interface HybridDiscoveryConfig {
  // AI settings
  aiEnabled: boolean;
  llmConfig?: LLMConfig;

  // Pattern matching settings
  patternMatchingEnabled: boolean;
  patternConfidenceThreshold: number; // 0.9 = high confidence required

  // Routing thresholds
  lowConfidenceThreshold: number; // 0.7 = below this, go straight to AI
  mediumConfidenceThreshold: number; // 0.9 = above this, trust pattern

  // Cost controls
  maxCostPerSession?: number;
  monthlyBudget?: number;
}

export interface HybridDiscoveryResult {
  success: boolean;
  discoveredCIs: any[];
  confidence: number;
  executionTimeMs: number;
  cost: number;
  method: 'pattern' | 'ai' | 'fallback';
  patternUsed?: string;
  aiReasoning?: string;
  error?: string;
}

export class HybridDiscoveryOrchestrator {
  private config: HybridDiscoveryConfig;
  private patternMatcher: PatternMatcher;
  private aiCoordinator: AIAgentCoordinator | null = null;
  private patternStorage: PatternStorageService;

  constructor(config?: Partial<HybridDiscoveryConfig>) {
    // Default configuration
    this.config = {
      aiEnabled: process.env['AI_DISCOVERY_ENABLED'] === 'true',
      patternMatchingEnabled: true,
      patternConfidenceThreshold: 0.9,
      lowConfidenceThreshold: 0.7,
      mediumConfidenceThreshold: 0.9,
      maxCostPerSession: parseFloat(
        process.env['AI_DISCOVERY_MAX_COST_PER_SESSION'] || '0.50'
      ),
      monthlyBudget: parseFloat(
        process.env['AI_DISCOVERY_MONTHLY_BUDGET'] || '100.00'
      ),
      ...config,
    };

    this.patternStorage = new PatternStorageService();
    this.patternMatcher = new PatternMatcher(this.patternStorage);

    // Initialize AI coordinator if enabled
    if (this.config.aiEnabled) {
      try {
        const llmConfig = this.config.llmConfig || getDefaultLLMConfig();
        this.aiCoordinator = new AIAgentCoordinator(llmConfig);
        logger.info('AI discovery enabled', {
          provider: llmConfig.provider,
          model: llmConfig.model,
        });
      } catch (error) {
        logger.error('Failed to initialize AI coordinator', { error });
        this.config.aiEnabled = false;
      }
    }

    logger.info('Hybrid discovery orchestrator initialized', {
      aiEnabled: this.config.aiEnabled,
      patternMatchingEnabled: this.config.patternMatchingEnabled,
    });
  }

  /**
   * Main discovery entry point with hybrid routing
   */
  async discover(context: AIDiscoveryContext): Promise<HybridDiscoveryResult> {
    const startTime = Date.now();

    logger.info('Starting hybrid discovery');

    try {
      await resolveDiscoveryHost(context.targetHost);
      // TIER 1: Try Pattern Matching (Fast Path)
      if (this.config.patternMatchingEnabled && context.scanResult) {
        const patternResult = await this.tryPatternMatch(context);

        if (patternResult && patternResult.confidence >= this.config.mediumConfidenceThreshold) {
          // High confidence - use pattern
          logger.info('Pattern match with high confidence', {
            patternId: patternResult.patternUsed,
            confidence: patternResult.confidence,
          });
          return patternResult;
        } else if (
          patternResult &&
          patternResult.confidence >= this.config.lowConfidenceThreshold
        ) {
          // Medium confidence - use pattern but may verify with AI later
          logger.info('Pattern match with medium confidence', {
            patternId: patternResult.patternUsed,
            confidence: patternResult.confidence,
          });
          return patternResult;
        }
      }

      // TIER 2: AI Discovery (Intelligent Path)
      if (this.config.aiEnabled && this.aiCoordinator) {
        // Check budget before AI call
        if (!(await this.checkBudget())) {
          logger.warn('Monthly budget exceeded, skipping AI discovery');
          return this.createFallbackResult(
            startTime,
            'Budget exceeded, AI discovery disabled'
          );
        }

        const aiResult = await this.tryAIDiscovery(context);
        return aiResult;
      }

      // TIER 3: Fallback
      logger.warn('No discovery method succeeded', {
        aiEnabled: this.config.aiEnabled,
        patternMatchingEnabled: this.config.patternMatchingEnabled,
      });

      return this.createFallbackResult(
        startTime,
        'No discovery method available'
      );
    } catch (error) {
      logger.error('Hybrid discovery failed', { error });
      return {
        success: false,
        discoveredCIs: [],
        confidence: 0,
        executionTimeMs: Date.now() - startTime,
        cost: 0,
        method: 'fallback',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Try pattern matching (Tier 1)
   */
  private async tryPatternMatch(
    context: AIDiscoveryContext
  ): Promise<HybridDiscoveryResult | null> {
    const startTime = Date.now();

    try {
      logger.debug('Attempting pattern match');

      // Match scan result against patterns
      const match: PatternMatch | null = await this.patternMatcher.match(
        context.scanResult
      );

      if (!match) {
        logger.debug('No pattern match found');
        return null;
      }

      logger.info('Pattern matched', {
        patternId: match.patternId,
        confidence: match.confidence,
      });

      // Execute pattern discovery
      const cis = await this.patternMatcher.executePattern(
        match.patternId,
        context,
        match.activeSetHash
      );

      const executionTime = Date.now() - startTime;

      return {
        success: true,
        discoveredCIs: cis,
        confidence: match.confidence,
        executionTimeMs: executionTime,
        cost: 0, // Patterns are free!
        method: 'pattern',
        patternUsed: match.patternId,
      };
    } catch (error) {
      if (error instanceof Error &&
        [UNSUPPORTED_PATTERN_PLAN, PATTERN_NOT_ACTIVE, PATTERN_STATE_UNAVAILABLE, DISCOVERY_TARGET_REFUSED]
          .includes(error.message)) {
        throw error;
      }
      logger.error('Pattern matching failed', { error });
      return null;
    }
  }

  /**
   * Try AI discovery (Tier 2)
   */
  private async tryAIDiscovery(
    context: AIDiscoveryContext
  ): Promise<HybridDiscoveryResult> {
    const startTime = Date.now();

    try {
      if (!this.aiCoordinator) {
        throw new Error('AI coordinator not initialized');
      }

      logger.info('Starting AI discovery');

      const result: AIDiscoveryResult = await this.aiCoordinator.discover(context);

      return {
        success: result.success,
        discoveredCIs: result.discoveredCIs,
        confidence: result.confidence,
        executionTimeMs: result.executionTimeMs,
        cost: result.cost || 0,
        method: 'ai',
        aiReasoning: result.session.aiReasoning,
        error: result.error,
      };
    } catch (error) {
      logger.error('AI discovery failed', { error });
      return {
        success: false,
        discoveredCIs: [],
        confidence: 0,
        executionTimeMs: Date.now() - startTime,
        cost: 0,
        method: 'ai',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Create fallback result
   */
  private createFallbackResult(
    startTime: number,
    reason: string
  ): HybridDiscoveryResult {
    return {
      success: false,
      discoveredCIs: [],
      confidence: 0,
      executionTimeMs: Date.now() - startTime,
      cost: 0,
      method: 'fallback',
      error: reason,
    };
  }

  /**
   * Check if monthly budget allows AI discovery
   */
  private async checkBudget(): Promise<boolean> {
    if (!this.config.monthlyBudget) {
      return true; // No budget limit
    }

    try {
      const client = await this.patternStorage['postgresClient'].getClient();

      const result = await client.query(
        `SELECT SUM(estimated_cost) as total_cost
         FROM ai_discovery_sessions
         WHERE DATE(started_at) >= DATE_TRUNC('month', CURRENT_DATE)
         AND estimated_cost IS NOT NULL`
      );

      client.release();

      const totalCost = parseFloat(result.rows[0]?.total_cost || '0');

      logger.debug('Monthly budget check', {
        spent: totalCost,
        budget: this.config.monthlyBudget,
      });

      return totalCost < this.config.monthlyBudget;
    } catch (error) {
      logger.error('Budget check failed', { error });
      return true; // Allow on error
    }
  }

  /**
   * Get configuration
   */
  getConfig(): HybridDiscoveryConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<HybridDiscoveryConfig>): void {
    this.config = { ...this.config, ...updates };
    logger.info('Configuration updated', updates);
  }

  /**
   * Reload patterns from database
   */
  async reloadPatterns(): Promise<void> {
    await this.patternMatcher.loadPatterns();
    logger.info('Patterns reloaded');
  }

  /**
   * Get pattern matcher (for external access)
   */
  getPatternMatcher(): PatternMatcher {
    return this.patternMatcher;
  }

  /**
   * Get AI coordinator (for external access)
   */
  getAICoordinator(): AIAgentCoordinator | null {
    return this.aiCoordinator;
  }
}
