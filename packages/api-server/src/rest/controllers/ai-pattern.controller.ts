// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * AI Pattern Controller
 *
 * REST API controller backing the AI Pattern Learning UI (Pattern Library,
 * Discovery Sessions, Cost Analytics). Delegates pattern persistence and
 * lifecycle transitions to @cmdb/ai-discovery's PatternStorageService /
 * PatternWorkflow / PatternAnalyzer / PatternCompiler / PatternValidator,
 * and reads/aggregates ai_discovery_sessions directly (sessions are not
 * owned by any ai-discovery service class).
 */

import { Response } from 'express';
import { getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import {
  PatternStorageService,
  PatternAnalyzer,
  PatternCompiler,
  PatternValidator,
  PatternWorkflow,
  PatternListFilters,
  AIDiscoverySession,
  AIToolCall,
} from '@cmdb/ai-discovery';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';

/**
 * Raw ai_discovery_sessions row shape, mirroring the column mapping
 * PatternAnalyzer/PatternWorkflow's private rowToSession() use internally.
 */
interface SessionRow {
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
  tool_calls: AIToolCall[] | null;
  ai_reasoning: string | null;
  pattern_matched: string | null;
  error_message: string | null;
  retry_count: number | null;
}

// Pattern executions served from the pattern-matcher fast path get a
// synthetic session row (PatternStorageService.createExecutionSession())
// purely to satisfy ai_pattern_usage.session_id's foreign key. They never
// called an LLM and carry no cost, so cost/learning analytics that report
// on real AI-driven discovery must exclude them.
const PATTERN_MATCHER_SYNTHETIC_MODEL = 'pattern-matcher';

export class AIPatternController {
  private postgresClient = getPostgresClient();
  private storage: PatternStorageService;
  private analyzer: PatternAnalyzer;
  private compiler: PatternCompiler;
  private validator: PatternValidator;
  private workflow: PatternWorkflow;

  constructor(
    storage?: PatternStorageService,
    analyzer?: PatternAnalyzer,
    compiler?: PatternCompiler,
    validator?: PatternValidator,
    workflow?: PatternWorkflow
  ) {
    this.storage = storage || new PatternStorageService();
    this.analyzer = analyzer || new PatternAnalyzer(this.storage);
    this.compiler = compiler || new PatternCompiler();
    this.validator = validator || new PatternValidator();
    this.workflow = workflow || new PatternWorkflow(this.storage, this.validator, this.compiler);
  }

  /**
   * Resolve the authenticated actor for workflow audit fields
   * (submitted_by/approved_by/rejected_by/...). Request bodies are never
   * trusted for identity - only req.user is authoritative.
   */
  private getActor(req: AuthenticatedRequest): string {
    return req.user?._userId || req.user?._username || 'system';
  }

  /**
   * Normalize a `status` query filter that Joi (`Joi.alternatives(string,
   * array)`) may hand us as either a comma-separated string or - when the
   * client repeats the param (`?status=a&status=b`) or uses axios's default
   * array serialization (`?status[]=a&status[]=b`) - an actual string
   * array. Never `String(array)` this: Array.prototype.toString silently
   * joins with commas and swallows any per-value comma-splitting intent.
   */
  private normalizeStatusFilter(raw: unknown): string[] | undefined {
    if (raw === undefined || raw === null || raw === '') {
      return undefined;
    }
    const parts = Array.isArray(raw) ? raw.map((value) => String(value)) : String(raw).split(',');
    const values = parts.map((value) => value.trim()).filter((value) => value.length > 0);
    return values.length > 0 ? values : undefined;
  }

  // ==========================================================================
  // Pattern Management
  // ==========================================================================

  /**
   * List patterns across every lifecycle status with optional filters.
   * GET /ai/patterns
   */
  async listPatterns(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const limitParam =
        req.query['limit'] !== undefined ? parseInt(String(req.query['limit']), 10) : undefined;
      const offsetParam =
        req.query['offset'] !== undefined ? parseInt(String(req.query['offset']), 10) : undefined;

      if (limitParam !== undefined && (isNaN(limitParam) || limitParam < 1 || limitParam > 500)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'limit must be a number between 1 and 500',
        });
        return;
      }
      if (offsetParam !== undefined && (isNaN(offsetParam) || offsetParam < 0)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'offset must be a non-negative number',
        });
        return;
      }

      const filters: PatternListFilters = {
        status: this.normalizeStatusFilter(req.query['status']),
        category: req.query['category'] ? String(req.query['category']) : undefined,
        isActive:
          req.query['isActive'] === 'true'
            ? true
            : req.query['isActive'] === 'false'
              ? false
              : undefined,
        minConfidence:
          req.query['minConfidence'] !== undefined
            ? parseFloat(String(req.query['minConfidence']))
            : undefined,
        minUsage:
          req.query['minUsage'] !== undefined
            ? parseInt(String(req.query['minUsage']), 10)
            : undefined,
        search: req.query['search'] ? String(req.query['search']) : undefined,
        limit: limitParam,
        offset: offsetParam,
      };

      const patterns = await this.storage.listPatterns(filters);

      res.json({
        success: true,
        data: patterns,
      });
    } catch (error) {
      logger.error('Error listing patterns', error);
      res.status(500).json({
        success: false,
        error: 'Failed to list patterns',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get a single pattern by ID.
   * GET /ai/patterns/:patternId
   */
  async getPattern(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { patternId } = req.params;
      const pattern = await this.storage.getPattern(patternId);

      if (!pattern) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Pattern '${patternId}' not found`,
        });
        return;
      }

      res.json({
        success: true,
        data: pattern,
      });
    } catch (error) {
      logger.error('Error getting pattern', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get pattern',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Delete a pattern outright.
   * DELETE /ai/patterns/:patternId
   */
  async deletePattern(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { patternId } = req.params;
      const deleted = await this.storage.deletePattern(patternId);

      if (!deleted) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Pattern '${patternId}' not found`,
        });
        return;
      }

      res.json({
        success: true,
        message: 'Pattern deleted successfully',
      });
    } catch (error) {
      logger.error('Error deleting pattern', error);
      res.status(500).json({
        success: false,
        error: 'Failed to delete pattern',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // ==========================================================================
  // Pattern Workflow
  // ==========================================================================

  /**
   * Submit a draft pattern for review (draft -> review).
   * POST /ai/patterns/:patternId/submit
   */
  async submitForReview(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { patternId } = req.params;
      const notes = typeof req.body?.notes === 'string' ? req.body.notes : undefined;

      const result = await this.workflow.submitForReview(patternId, this.getActor(req), notes);

      if (!result.success) {
        this.sendWorkflowFailure(res, patternId, result);
        return;
      }

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Error submitting pattern for review', error);
      res.status(500).json({
        success: false,
        error: 'Failed to submit pattern',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Approve a pattern under review (review -> approved).
   * POST /ai/patterns/:patternId/approve
   */
  async approvePattern(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { patternId } = req.params;
      const notes = typeof req.body?.notes === 'string' ? req.body.notes : undefined;

      const result = await this.workflow.approvePattern(patternId, this.getActor(req), notes);

      if (!result.success) {
        this.sendWorkflowFailure(res, patternId, result);
        return;
      }

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Error approving pattern', error);
      res.status(500).json({
        success: false,
        error: 'Failed to approve pattern',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Reject a pattern under review (review -> draft). A reason is required
   * for the audit trail (see ai_pattern_review_history).
   * POST /ai/patterns/:patternId/reject
   */
  async rejectPattern(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { patternId } = req.params;
      const reason: string = req.body.reason;

      const result = await this.workflow.rejectPattern(patternId, this.getActor(req), reason);

      if (!result.success) {
        this.sendWorkflowFailure(res, patternId, result);
        return;
      }

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Error rejecting pattern', error);
      res.status(500).json({
        success: false,
        error: 'Failed to reject pattern',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Activate an approved pattern (approved -> active).
   * POST /ai/patterns/:patternId/activate
   */
  async activatePattern(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { patternId } = req.params;

      const result = await this.workflow.activatePattern(patternId, this.getActor(req));

      if (!result.success) {
        this.sendWorkflowFailure(res, patternId, result);
        return;
      }

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Error activating pattern', error);
      res.status(500).json({
        success: false,
        error: 'Failed to activate pattern',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Deactivate an active pattern (active -> deprecated).
   * POST /ai/patterns/:patternId/deactivate
   */
  async deactivatePattern(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { patternId } = req.params;
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;

      const result = await this.workflow.deactivatePattern(patternId, this.getActor(req), reason);

      if (!result.success) {
        this.sendWorkflowFailure(res, patternId, result);
        return;
      }

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Error deactivating pattern', error);
      res.status(500).json({
        success: false,
        error: 'Failed to deactivate pattern',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Map a failed PatternWorkflow transition onto the right HTTP status:
   * 404 when the pattern itself doesn't exist, 409 for every other
   * transition/validation guard (wrong current status, failed
   * validation), 500 when the workflow tagged the failure `internal`
   * (an infrastructure/transaction failure, e.g. the atomic status+audit
   * write itself) -- those never carry the raw DB error text, only the
   * workflow's own generic message, so failure detail never leaks to the
   * client. The workflow result is always echoed back under `data` so the
   * frontend can read `.error`/`.validation` uniformly regardless of
   * status code.
   */
  private sendWorkflowFailure(
    res: Response,
    patternId: string,
    result: { success: boolean; error?: string; validation?: unknown; internal?: boolean }
  ): void {
    if (result.internal) {
      res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: `Failed to process transition for pattern '${patternId}'`,
        data: result,
      });
      return;
    }

    const notFound = result.error === 'Pattern not found';
    res.status(notFound ? 404 : 409).json({
      success: false,
      error: notFound ? 'Not Found' : 'Conflict',
      message: notFound ? `Pattern '${patternId}' not found` : result.error,
      data: result,
    });
  }

  /**
   * Validate a pattern's detection/discovery code, security posture, and
   * test cases without transitioning its status.
   * POST /ai/patterns/:patternId/validate
   */
  async validatePattern(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { patternId } = req.params;
      const pattern = await this.storage.getPattern(patternId);

      if (!pattern) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Pattern '${patternId}' not found`,
        });
        return;
      }

      const result = await this.validator.validate(pattern);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('Error validating pattern', error);
      res.status(500).json({
        success: false,
        error: 'Failed to validate pattern',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get per-execution usage metrics for a pattern over the trailing N days.
   * GET /ai/patterns/:patternId/usage
   */
  async getPatternUsage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { patternId } = req.params;
      const pattern = await this.storage.getPattern(patternId);

      if (!pattern) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Pattern '${patternId}' not found`,
        });
        return;
      }

      const days = req.query['days'] !== undefined ? parseInt(String(req.query['days']), 10) : 30;
      if (isNaN(days) || days < 1 || days > 365) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'days must be a number between 1 and 365',
        });
        return;
      }

      const usage = await this.storage.getPatternUsage(patternId, days);

      res.json({
        success: true,
        data: usage,
      });
    } catch (error) {
      logger.error('Error getting pattern usage', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get pattern usage',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get the full workflow transition history for a pattern.
   * GET /ai/patterns/:patternId/history
   */
  async getPatternHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { patternId } = req.params;
      const pattern = await this.storage.getPattern(patternId);

      if (!pattern) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Pattern '${patternId}' not found`,
        });
        return;
      }

      const history = await this.workflow.getPatternHistory(patternId);

      res.json({
        success: true,
        data: history,
      });
    } catch (error) {
      logger.error('Error getting pattern history', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get pattern history',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Compile pattern candidates from similar AI discovery sessions, save
   * them as drafts, and submit them for review (auto-approving where
   * eligible).
   * POST /ai/patterns/compile
   */
  async compileAndSubmitPatterns(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const result = await this.workflow.compileAndSubmitPatterns();

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('Error compiling patterns', error);
      res.status(500).json({
        success: false,
        error: 'Failed to compile patterns',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // ==========================================================================
  // Discovery Sessions
  // ==========================================================================

  /**
   * List discovery sessions with optional filters.
   * GET /ai/sessions
   */
  async listSessions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const limit =
        req.query['limit'] !== undefined ? parseInt(String(req.query['limit']), 10) : 100;
      const offset =
        req.query['offset'] !== undefined ? parseInt(String(req.query['offset']), 10) : 0;

      if (isNaN(limit) || limit < 1 || limit > 500) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'limit must be a number between 1 and 500',
        });
        return;
      }
      if (isNaN(offset) || offset < 0) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'offset must be a non-negative number',
        });
        return;
      }

      const status = this.normalizeStatusFilter(req.query['status']);
      const aiModel = req.query['aiModel'] ? String(req.query['aiModel']) : undefined;
      const dateFrom = req.query['dateFrom'] ? String(req.query['dateFrom']) : undefined;
      const dateTo = req.query['dateTo'] ? String(req.query['dateTo']) : undefined;
      const minCost =
        req.query['minCost'] !== undefined ? parseFloat(String(req.query['minCost'])) : undefined;
      const maxCost =
        req.query['maxCost'] !== undefined ? parseFloat(String(req.query['maxCost'])) : undefined;
      const search = req.query['search'] ? String(req.query['search']) : undefined;

      const conditions: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      if (status && status.length > 0) {
        conditions.push(`status = ANY($${paramIndex++})`);
        values.push(status);
      }
      if (aiModel) {
        conditions.push(`ai_model = $${paramIndex++}`);
        values.push(aiModel);
      }
      if (dateFrom) {
        conditions.push(`started_at >= $${paramIndex++}`);
        values.push(dateFrom);
      }
      if (dateTo) {
        conditions.push(`started_at <= $${paramIndex++}`);
        values.push(dateTo);
      }
      if (minCost !== undefined) {
        conditions.push(`estimated_cost >= $${paramIndex++}`);
        values.push(minCost);
      }
      if (maxCost !== undefined) {
        conditions.push(`estimated_cost <= $${paramIndex++}`);
        values.push(maxCost);
      }
      if (search) {
        conditions.push(`(target_host ILIKE $${paramIndex} OR session_id ILIKE $${paramIndex})`);
        values.push(`%${search}%`);
        paramIndex++;
      }
      // Pattern executions served from the fast path get a synthetic
      // session row purely to satisfy ai_pattern_usage's foreign key; they
      // never called an LLM and would misrepresent the discovery session
      // list, so exclude them unless the caller opts in.
      const includeSynthetic = req.query['includeSynthetic'] === 'true';
      if (!includeSynthetic) {
        conditions.push(`ai_model <> $${paramIndex++}`);
        values.push(PATTERN_MATCHER_SYNTHETIC_MODEL);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      values.push(limit, offset);

      const result = await this.postgresClient.query(
        `SELECT * FROM ai_discovery_sessions
         ${where}
         ORDER BY started_at DESC
         LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
        values
      );

      res.json({
        success: true,
        data: result.rows.map((row: SessionRow) => this.rowToSession(row)),
      });
    } catch (error) {
      logger.error('Error listing sessions', error);
      res.status(500).json({
        success: false,
        error: 'Failed to list sessions',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get a single discovery session by ID. Synthetic pattern-matcher session
   * rows (see PATTERN_MATCHER_SYNTHETIC_MODEL) never called an LLM and
   * exist only to satisfy ai_pattern_usage's foreign key, so a direct
   * lookup 404s for them exactly as it would for an unknown session id -
   * there is no separate internal endpoint that needs to see them.
   * GET /ai/sessions/:sessionId
   */
  async getSession(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { sessionId } = req.params;

      const result = await this.postgresClient.query(
        'SELECT * FROM ai_discovery_sessions WHERE session_id = $1 AND ai_model <> $2',
        [sessionId, PATTERN_MATCHER_SYNTHETIC_MODEL]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Session '${sessionId}' not found`,
        });
        return;
      }

      res.json({
        success: true,
        data: this.rowToSession(result.rows[0]),
      });
    } catch (error) {
      logger.error('Error getting session', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get session',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Analyze a session to see whether it contributes to a learnable pattern.
   * POST /ai/sessions/:sessionId/analyze
   */
  async analyzeSession(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { sessionId } = req.params;

      const result = await this.postgresClient.query(
        'SELECT * FROM ai_discovery_sessions WHERE session_id = $1',
        [sessionId]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Session '${sessionId}' not found`,
        });
        return;
      }

      const session = this.rowToSession(result.rows[0]);
      const analysis = await this.analyzer.analyzeSession(session);

      res.json({
        success: true,
        data: analysis,
      });
    } catch (error) {
      logger.error('Error analyzing session', error);
      res.status(500).json({
        success: false,
        error: 'Failed to analyze session',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // ==========================================================================
  // Analytics
  // ==========================================================================

  /**
   * Get cost analytics for real AI-driven discovery sessions (the synthetic
   * session rows pattern executions create to satisfy ai_pattern_usage's
   * foreign key are excluded - they never called an LLM and cost nothing).
   * GET /ai/analytics/cost
   */
  async getCostAnalytics(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const dateFrom = req.query['dateFrom'] ? String(req.query['dateFrom']) : null;
      const dateTo = req.query['dateTo'] ? String(req.query['dateTo']) : null;

      const totalCostResult = await this.postgresClient.query(
        `SELECT
          SUM(estimated_cost) as total_cost,
          COUNT(*) as total_sessions,
          AVG(estimated_cost) as avg_cost_per_session
        FROM ai_discovery_sessions
        WHERE ai_model <> $1
          AND ($2::timestamp IS NULL OR started_at >= $2)
          AND ($3::timestamp IS NULL OR started_at <= $3)`,
        [PATTERN_MATCHER_SYNTHETIC_MODEL, dateFrom, dateTo]
      );

      const costByModelResult = await this.postgresClient.query(
        `SELECT
          ai_model,
          SUM(estimated_cost) as cost,
          COUNT(*) as sessions
        FROM ai_discovery_sessions
        WHERE ai_model <> $1
          AND ($2::timestamp IS NULL OR started_at >= $2)
          AND ($3::timestamp IS NULL OR started_at <= $3)
        GROUP BY ai_model
        ORDER BY cost DESC NULLS LAST`,
        [PATTERN_MATCHER_SYNTHETIC_MODEL, dateFrom, dateTo]
      );

      // ::text casts to a bare `YYYY-MM-DD` (no time/offset suffix) so the
      // frontend never has to parse a driver-specific Date representation.
      // Ordered DESC + LIMIT 90 to keep the newest 90-day window when the
      // range is unbounded, then reversed below so the response - and the
      // chart it feeds - reads oldest-to-newest, chronologically.
      const costByDayResult = await this.postgresClient.query(
        `SELECT
          DATE(started_at)::text as date,
          SUM(estimated_cost) as cost,
          COUNT(*) as sessions
        FROM ai_discovery_sessions
        WHERE ai_model <> $1
          AND ($2::timestamp IS NULL OR started_at >= $2)
          AND ($3::timestamp IS NULL OR started_at <= $3)
        GROUP BY DATE(started_at)
        ORDER BY date DESC
        LIMIT 90`,
        [PATTERN_MATCHER_SYNTHETIC_MODEL, dateFrom, dateTo]
      );

      // Pattern hits: successful fast-path matches in the same window, from
      // ai_pattern_usage (the table PatternStorageService.recordUsage()
      // writes to on every pattern execution).
      const patternHitsResult = await this.postgresClient.query(
        `SELECT COUNT(*) as pattern_hits
         FROM ai_pattern_usage
         WHERE success = true
           AND ($1::timestamp IS NULL OR "timestamp" >= $1)
           AND ($2::timestamp IS NULL OR "timestamp" <= $2)`,
        [dateFrom, dateTo]
      );

      const totalCost = parseFloat(totalCostResult.rows[0]?.total_cost || 0);
      const totalSessions = parseInt(totalCostResult.rows[0]?.total_sessions || 0, 10);
      const avgCostPerSession = parseFloat(totalCostResult.rows[0]?.avg_cost_per_session || 0);
      const patternHits = parseInt(patternHitsResult.rows[0]?.pattern_hits || 0, 10);
      const aiDiscoveries = totalSessions;

      // Each pattern hit is a discovery that took the free/fast path instead
      // of an LLM call; estimate what it would have cost had it gone
      // through AI discovery at this window's average session cost.
      const totalSaved = patternHits * avgCostPerSession;
      const percentSaved =
        patternHits + aiDiscoveries > 0
          ? (patternHits / (patternHits + aiDiscoveries)) * 100
          : 0;

      const analytics = {
        totalCost,
        totalSessions,
        avgCostPerSession,
        costByModel: costByModelResult.rows.map((row) => ({
          aiModel: row.ai_model,
          cost: parseFloat(row.cost || 0),
          sessions: parseInt(row.sessions || 0, 10),
        })),
        costByDay: [...costByDayResult.rows].reverse().map((row) => ({
          date: row.date,
          cost: parseFloat(row.cost || 0),
          sessions: parseInt(row.sessions || 0, 10),
        })),
        savingsFromPatterns: {
          totalSaved,
          percentSaved,
          patternHits,
          aiDiscoveries,
        },
      };

      res.json({
        success: true,
        data: analytics,
      });
    } catch (error) {
      logger.error('Error getting cost analytics', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get cost analytics',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get pattern-learning-flywheel statistics.
   * GET /ai/analytics/learning
   */
  async getLearningStats(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const patternStatsResult = await this.postgresClient.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active') as active_patterns,
          COUNT(*) FILTER (WHERE status = 'review') as pending_review,
          COUNT(*) as total_patterns,
          AVG(confidence_score) as avg_confidence
        FROM ai_discovery_patterns
      `);

      const sessionResult = await this.postgresClient.query(
        `SELECT COUNT(*) as total_sessions
         FROM ai_discovery_sessions
         WHERE status = 'completed' AND ai_model <> $1`,
        [PATTERN_MATCHER_SYNTHETIC_MODEL]
      );

      // auto-approval-system is the fixed performed_by PatternWorkflow.
      // autoApproveIfEligible() records when it auto-approves a pattern; any
      // other actor approving is a manual approval (see
      // ai_pattern_review_history, 004_run_logs_and_pattern_review.sql).
      const approvalResult = await this.postgresClient.query(`
        SELECT
          COUNT(*) FILTER (WHERE performed_by = 'auto-approval-system') as auto_approved,
          COUNT(*) FILTER (WHERE performed_by <> 'auto-approval-system') as manual_approved
        FROM ai_pattern_review_history
        WHERE action = 'approve'
      `);

      const stats = {
        totalPatterns: parseInt(patternStatsResult.rows[0]?.total_patterns || 0, 10),
        activePatterns: parseInt(patternStatsResult.rows[0]?.active_patterns || 0, 10),
        pendingReview: parseInt(patternStatsResult.rows[0]?.pending_review || 0, 10),
        autoApproved: parseInt(approvalResult.rows[0]?.auto_approved || 0, 10),
        manualApproved: parseInt(approvalResult.rows[0]?.manual_approved || 0, 10),
        totalSessions: parseInt(sessionResult.rows[0]?.total_sessions || 0, 10),
        avgConfidence: parseFloat(patternStatsResult.rows[0]?.avg_confidence || 0),
      };

      res.json({
        success: true,
        data: stats,
      });
    } catch (error) {
      logger.error('Error getting learning stats', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get learning stats',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Convert a raw ai_discovery_sessions row to the AIDiscoverySession domain
   * type (mirrors PatternAnalyzer/PatternWorkflow's private rowToSession()).
   */
  private rowToSession(row: SessionRow): AIDiscoverySession {
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
