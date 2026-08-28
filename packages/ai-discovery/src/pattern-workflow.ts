// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Pattern Workflow
 * Manages pattern lifecycle: draft → review → approved → active
 */

import { DiscoveryPattern, AIDiscoverySession } from './types';
import { PatternStorageService, type PatternReviewAction } from './pattern-storage';
import { PatternValidator, ValidationResult } from './pattern-validator';
import { PatternCompiler } from './pattern-compiler';
import { logger } from '@cmdb/common';
import { getPostgresClient } from '@cmdb/database';

export interface WorkflowAction {
  action: PatternReviewAction;
  performedBy: string;
  comment?: string;
  timestamp: Date;
}

export class PatternWorkflow {
  private storage: PatternStorageService;
  private validator: PatternValidator;
  private compiler: PatternCompiler;
  private postgresClient = getPostgresClient();

  constructor(
    storage?: PatternStorageService,
    validator?: PatternValidator,
    compiler?: PatternCompiler
  ) {
    this.storage = storage || new PatternStorageService();
    this.validator = validator || new PatternValidator();
    this.compiler = compiler || new PatternCompiler();
  }

  /**
   * Submit pattern for review (draft → review)
   */
  async submitForReview(
    patternId: string,
    submittedBy: string,
    comment?: string
  ): Promise<{
    success: boolean;
    validation?: ValidationResult;
    error?: string;
    internal?: boolean;
  }> {
    try {
      const pattern = await this.storage.getPattern(patternId);
      if (!pattern) {
        return { success: false, error: 'Pattern not found' };
      }

      if (pattern.status !== 'draft') {
        return {
          success: false,
          error: `Pattern status is ${pattern.status}, expected draft`,
        };
      }

      logger.info('Submitting pattern for review', { patternId, submittedBy });

      // Validate pattern
      const validation = await this.validator.validate(pattern);

      if (!validation.isValid) {
        logger.warn('Pattern validation failed', {
          patternId,
          errors: validation.errors,
        });
        return {
          success: false,
          validation,
          error: 'Pattern validation failed',
        };
      }

      // Persist the status transition and its ai_pattern_review_history
      // row (submit comment, see 004_run_logs_and_pattern_review.sql)
      // atomically -- a pattern can be commented on at more than one
      // transition, so the comment isn't a column on the pattern itself,
      // but the status change and its audit row must commit or roll back
      // together.
      await this.storage.transitionPattern(
        patternId,
        { status: 'review' },
        'submit',
        submittedBy,
        comment
      );

      logger.info('Pattern submitted for review', { patternId, submittedBy });

      return { success: true, validation };
    } catch (error) {
      // Infrastructure/transaction failure (e.g. the transitionPattern()
      // DB round-trip itself), not a guard/validation rejection -- tag it
      // so callers (the REST controller) surface a generic 500 rather than
      // mapping it to the same 409 used for expected guard failures, and
      // never echo the raw error text.
      logger.error('Error submitting pattern for review', { patternId, error });
      return {
        success: false,
        internal: true,
        error: 'Internal error while submitting pattern for review',
      };
    }
  }

  /**
   * Approve pattern (review → approved)
   */
  async approvePattern(
    patternId: string,
    approvedBy: string,
    comment?: string
  ): Promise<{
    success: boolean;
    error?: string;
    internal?: boolean;
  }> {
    try {
      const pattern = await this.storage.getPattern(patternId);
      if (!pattern) {
        return { success: false, error: 'Pattern not found' };
      }

      if (pattern.status !== 'review') {
        return {
          success: false,
          error: `Pattern status is ${pattern.status}, expected review`,
        };
      }

      logger.info('Approving pattern', { patternId, approvedBy });

      // Final validation before approval
      const validation = await this.validator.quickValidate(pattern);
      if (!validation.isValid) {
        return {
          success: false,
          error: `Validation failed: ${validation.errors.join(', ')}`,
        };
      }

      // Status/approval fields and the audit row commit or roll back
      // together -- see transitionPattern().
      await this.storage.transitionPattern(
        patternId,
        { status: 'approved', approvedBy, approvedAt: new Date() },
        'approve',
        approvedBy,
        comment
      );

      logger.info('Pattern approved', { patternId, approvedBy });

      return { success: true };
    } catch (error) {
      logger.error('Error approving pattern', { patternId, error });
      return {
        success: false,
        internal: true,
        error: 'Internal error while approving pattern',
      };
    }
  }

  /**
   * Reject pattern (review → draft)
   */
  async rejectPattern(
    patternId: string,
    rejectedBy: string,
    reason: string
  ): Promise<{
    success: boolean;
    error?: string;
    internal?: boolean;
  }> {
    try {
      const pattern = await this.storage.getPattern(patternId);
      if (!pattern) {
        return { success: false, error: 'Pattern not found' };
      }

      if (pattern.status !== 'review') {
        return {
          success: false,
          error: `Pattern status is ${pattern.status}, expected review`,
        };
      }

      logger.info('Rejecting pattern', { patternId, rejectedBy, reason });

      // Status and the audit row commit or roll back together -- see
      // transitionPattern().
      await this.storage.transitionPattern(
        patternId,
        { status: 'draft' },
        'reject',
        rejectedBy,
        reason
      );

      logger.info('Pattern rejected', { patternId, rejectedBy, reason });

      return { success: true };
    } catch (error) {
      logger.error('Error rejecting pattern', { patternId, error });
      return {
        success: false,
        internal: true,
        error: 'Internal error while rejecting pattern',
      };
    }
  }

  /**
   * Activate pattern (approved → active)
   */
  async activatePattern(
    patternId: string,
    activatedBy: string
  ): Promise<{
    success: boolean;
    error?: string;
    internal?: boolean;
  }> {
    try {
      const pattern = await this.storage.getPattern(patternId);
      if (!pattern) {
        return { success: false, error: 'Pattern not found' };
      }

      if (pattern.status !== 'approved') {
        return {
          success: false,
          error: `Pattern status is ${pattern.status}, expected approved`,
        };
      }

      logger.info('Activating pattern', { patternId, activatedBy });

      // Status/is_active fields and the audit row commit or roll back
      // together -- see transitionPattern().
      await this.storage.transitionPattern(
        patternId,
        { status: 'active', isActive: true },
        'activate',
        activatedBy
      );

      logger.info('Pattern activated', { patternId, activatedBy });

      return { success: true };
    } catch (error) {
      logger.error('Error activating pattern', { patternId, error });
      return {
        success: false,
        internal: true,
        error: 'Internal error while activating pattern',
      };
    }
  }

  /**
   * Deactivate pattern (active → deprecated)
   */
  async deactivatePattern(
    patternId: string,
    deactivatedBy: string,
    reason?: string
  ): Promise<{
    success: boolean;
    error?: string;
    internal?: boolean;
  }> {
    try {
      const pattern = await this.storage.getPattern(patternId);
      if (!pattern) {
        return { success: false, error: 'Pattern not found' };
      }

      if (pattern.status !== 'active') {
        return {
          success: false,
          error: `Pattern status is ${pattern.status}, expected active`,
        };
      }

      logger.info('Deactivating pattern', { patternId, deactivatedBy, reason });

      // Status/is_active fields and the audit row commit or roll back
      // together -- see transitionPattern().
      await this.storage.transitionPattern(
        patternId,
        { status: 'deprecated', isActive: false },
        'deactivate',
        deactivatedBy,
        reason
      );

      logger.info('Pattern deactivated', { patternId, deactivatedBy });

      return { success: true };
    } catch (error) {
      logger.error('Error deactivating pattern', { patternId, error });
      return {
        success: false,
        internal: true,
        error: 'Internal error while deactivating pattern',
      };
    }
  }

  /**
   * Auto-approve patterns based on criteria
   * (for patterns with very high confidence and usage)
   */
  async autoApproveIfEligible(patternId: string): Promise<boolean> {
    try {
      const pattern = await this.storage.getPattern(patternId);
      if (!pattern) {
        return false;
      }

      // Only auto-approve patterns in review state
      if (pattern.status !== 'review') {
        return false;
      }

      // Criteria for auto-approval:
      // 1. Learned from 5+ sessions
      // 2. Confidence score >= 0.90
      // 3. Passes all validation
      const eligibleForAutoApproval =
        pattern.learnedFromSessions &&
        pattern.learnedFromSessions.length >= 5 &&
        pattern.confidenceScore >= 0.9;

      if (!eligibleForAutoApproval) {
        logger.debug('Pattern not eligible for auto-approval', {
          patternId,
          sessions: pattern.learnedFromSessions?.length,
          confidence: pattern.confidenceScore,
        });
        return false;
      }

      // Validate
      const validation = await this.validator.quickValidate(pattern);
      if (!validation.isValid) {
        logger.warn('Pattern auto-approval blocked by validation', {
          patternId,
          errors: validation.errors,
        });
        return false;
      }

      // Auto-approve
      const result = await this.approvePattern(patternId, 'auto-approval-system');

      if (result.success) {
        logger.info('Pattern auto-approved', { patternId });
        return true;
      }

      return false;
    } catch (error) {
      logger.error('Error in auto-approval check', { patternId, error });
      return false;
    }
  }

  /**
   * Get patterns pending review
   */
  async getPendingReviewPatterns(): Promise<DiscoveryPattern[]> {
    const allPatterns = this.storage.getCachedPatterns();
    return allPatterns.filter(p => p.status === 'review');
  }

  /**
   * Get pattern workflow history, oldest first.
   *
   * Backed by ai_pattern_review_history (004_run_logs_and_pattern_review.sql),
   * which records the actual actor, timestamp, and comment/reason for every
   * submit/approve/reject/activate/deactivate call -- including reject and
   * deactivate transitions the field-based reconstruction below can't see
   * at all, since rejecting/deactivating a pattern doesn't leave a trace on
   * ai_discovery_patterns itself.
   */
  async getPatternHistory(patternId: string): Promise<WorkflowAction[]> {
    const pattern = await this.storage.getPattern(patternId);
    if (!pattern) {
      return [];
    }

    const reviewHistory = await this.storage.getReviewHistory(patternId);
    if (reviewHistory.length > 0) {
      return reviewHistory.map(entry => ({
        action: entry.action,
        performedBy: entry.performedBy,
        timestamp: entry.createdAt,
        comment: entry.comment ?? undefined,
      }));
    }

    // Fallback for patterns that predate this history table (or were saved
    // directly via storage.savePattern() without going through a workflow
    // method): reconstruct a best-effort history from the pattern's own
    // fields, same as before.
    const history: WorkflowAction[] = [
      {
        action: 'submit',
        performedBy: pattern.author,
        timestamp: pattern.createdAt,
        comment: 'Pattern created',
      },
    ];

    if (pattern.approvedAt && pattern.approvedBy) {
      history.push({
        action: 'approve',
        performedBy: pattern.approvedBy,
        timestamp: pattern.approvedAt,
      });
    }

    if (pattern.isActive && pattern.status === 'active') {
      history.push({
        action: 'activate',
        performedBy: pattern.approvedBy || 'system',
        timestamp: pattern.updatedAt,
      });
    }

    return history;
  }

  /**
   * Compile and save new patterns from AI discoveries
   */
  async compileAndSubmitPatterns(): Promise<{
    compiled: number;
    submitted: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    let compiled = 0;
    let submitted = 0;

    try {
      logger.info('Looking for pattern candidates to compile');

      // Get candidates from compiler
      const candidates = await this.compiler.getCandidates();

      logger.info('Found pattern candidates', { count: candidates.length });

      for (const candidate of candidates) {
        try {
          // Get sessions for this candidate
          const sessions = await this.getSessionsForCandidate(
            candidate.signature.sessions
          );

          if (sessions.length === 0) {
            logger.warn('No sessions found for candidate', {
              signature: candidate.signature.signatureHash,
            });
            continue;
          }

          // Compile pattern
          const pattern = await this.compiler.compilePattern(sessions);
          compiled++;

          // Save as draft
          await this.storage.savePattern(pattern);

          // Submit for review
          const submitResult = await this.submitForReview(
            pattern.patternId,
            'pattern-compiler'
          );

          if (submitResult.success) {
            submitted++;

            // Try auto-approval if eligible
            await this.autoApproveIfEligible(pattern.patternId);
          } else {
            errors.push(
              `Failed to submit ${pattern.patternId}: ${submitResult.error}`
            );
          }

          logger.info('Pattern compiled and submitted', {
            patternId: pattern.patternId,
            name: pattern.name,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          errors.push(`Compilation error: ${errorMsg}`);
          logger.error('Error compiling pattern', { error });
        }
      }

      logger.info('Pattern compilation complete', { compiled, submitted });

      return { compiled, submitted, errors };
    } catch (error) {
      logger.error('Error in pattern compilation workflow', { error });
      return {
        compiled,
        submitted,
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  }

  /**
   * Get sessions by IDs (helper method)
   *
   * Backs compileAndSubmitPatterns(): candidate.signature.sessions holds the
   * session_ids the analyzer already grouped as similar; resolve them to
   * full AIDiscoverySession rows so the compiler has real data to work from.
   */
  private async getSessionsForCandidate(
    sessionIds: string[]
  ): Promise<AIDiscoverySession[]> {
    if (sessionIds.length === 0) {
      return [];
    }

    const client = await this.postgresClient.getClient();

    try {
      const result = await client.query(
        `SELECT
          id, session_id, target_host, target_port,
          scan_result, status, started_at, completed_at,
          duration_ms, ai_model, total_tokens, prompt_tokens,
          completion_tokens, estimated_cost, discovered_cis,
          confidence_score, tool_calls, ai_reasoning,
          pattern_matched, error_message, retry_count,
          created_at
        FROM ai_discovery_sessions
        WHERE session_id = ANY($1)`,
        [sessionIds]
      );

      return result.rows.map(row => this.rowToSession(row));
    } catch (error) {
      logger.error('Failed to fetch sessions for candidate', {
        sessionIds,
        error,
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Convert database row to AIDiscoverySession
   * (mirrors PatternAnalyzer.rowToSession's column mapping)
   */
  private rowToSession(row: {
    id: string;
    session_id: string;
    target_host: string;
    target_port: number;
    status: 'running' | 'completed' | 'failed';
    started_at: Date;
    completed_at: Date | null;
    duration_ms: number | null;
    ai_model: string;
    total_tokens: number | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    estimated_cost: string | null;
    discovered_cis: unknown[] | null;
    confidence_score: number | null;
    tool_calls: AIDiscoverySession['toolCalls'] | null;
    ai_reasoning: string | null;
    pattern_matched: string | null;
    error_message: string | null;
    retry_count: number | null;
  }): AIDiscoverySession {
    return {
      id: row.id,
      sessionId: row.session_id,
      targetHost: row.target_host,
      targetPort: row.target_port,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      aiModel: row.ai_model,
      totalTokens: row.total_tokens ?? undefined,
      promptTokens: row.prompt_tokens ?? undefined,
      completionTokens: row.completion_tokens ?? undefined,
      estimatedCost: row.estimated_cost ? parseFloat(row.estimated_cost) : undefined,
      discoveredCIs: row.discovered_cis || [],
      confidenceScore: row.confidence_score ?? undefined,
      toolCalls: row.tool_calls || [],
      aiReasoning: row.ai_reasoning ?? undefined,
      patternMatched: row.pattern_matched ?? undefined,
      errorMessage: row.error_message ?? undefined,
      retryCount: row.retry_count || 0,
    };
  }
}
