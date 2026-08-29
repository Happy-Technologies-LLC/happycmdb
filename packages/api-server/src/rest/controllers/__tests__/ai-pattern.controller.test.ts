// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for AIPatternController: actor derivation from req.user (never
 * the request body), 404/409/400 mapping for unknown IDs and invalid
 * workflow transitions, list-endpoint filter building, session/cost
 * analytics computation, and compile error propagation.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Response } from 'express';

jest.mock('@cmdb/common', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@cmdb/database', () => ({
  getPostgresClient: jest.fn(),
}));

import { getPostgresClient, type PostgresClient } from '@cmdb/database';
import type {
  PatternStorageService,
  PatternAnalyzer,
  PatternCompiler,
  PatternValidator,
  PatternWorkflow,
} from '@cmdb/ai-discovery';
import { AIPatternController } from '../ai-pattern.controller';
import type { AuthenticatedRequest } from '../../../middleware/auth.middleware';

type Json = Record<string, unknown>;

function mockRes(): Response {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis() as unknown as Response['status'],
    json: jest.fn().mockReturnThis() as unknown as Response['json'],
  };
  return res as Response;
}

function statusOf(res: Response): number {
  const statusMock = res.status as jest.Mock<(code: number) => Response>;
  return statusMock.mock.calls.length > 0 ? statusMock.mock.calls[0][0] : 200;
}

function bodyOf(res: Response): Json {
  const jsonMock = res.json as jest.Mock<(body: Json) => Response>;
  return jsonMock.mock.calls[0][0];
}

describe('AIPatternController', () => {
  let mockStorage: {
    listPatterns: jest.Mock<(...args: never[]) => Promise<unknown>>;
    getPattern: jest.Mock<(patternId: string) => Promise<unknown>>;
    deletePattern: jest.Mock<(patternId: string) => Promise<boolean>>;
    getPatternUsage: jest.Mock<(...args: never[]) => Promise<unknown>>;
  };
  let mockAnalyzer: { analyzeSession: jest.Mock<(...args: never[]) => Promise<unknown>> };
  let mockCompiler: Record<string, never>;
  let mockValidator: { validate: jest.Mock<(...args: never[]) => Promise<unknown>> };
  let mockWorkflow: {
    submitForReview: jest.Mock<
      (...args: never[]) => Promise<{ success: boolean; error?: string; internal?: boolean }>
    >;
    approvePattern: jest.Mock<
      (...args: never[]) => Promise<{ success: boolean; error?: string; internal?: boolean }>
    >;
    rejectPattern: jest.Mock<
      (...args: never[]) => Promise<{ success: boolean; error?: string; internal?: boolean }>
    >;
    activatePattern: jest.Mock<
      (...args: never[]) => Promise<{ success: boolean; error?: string; internal?: boolean }>
    >;
    deactivatePattern: jest.Mock<
      (...args: never[]) => Promise<{ success: boolean; error?: string; internal?: boolean }>
    >;
    getPatternHistory: jest.Mock<(patternId: string) => Promise<unknown>>;
    compileAndSubmitPatterns: jest.Mock<() => Promise<unknown>>;
  };
  let mockQuery: jest.Mock<(text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>;
  let controller: AIPatternController;

  function authedReq(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
    return {
      params: {},
      query: {},
      body: {},
      user: { _userId: 'user-1', _username: 'alice', _role: 'operator', _type: 'access' },
      ...overrides,
    } as unknown as AuthenticatedRequest;
  }

  beforeEach(() => {
    mockStorage = {
      listPatterns: jest.fn(),
      getPattern: jest.fn(),
      deletePattern: jest.fn(),
      getPatternUsage: jest.fn(),
    };
    mockAnalyzer = { analyzeSession: jest.fn() };
    mockCompiler = {};
    mockValidator = { validate: jest.fn() };
    mockWorkflow = {
      submitForReview: jest.fn(),
      approvePattern: jest.fn(),
      rejectPattern: jest.fn(),
      activatePattern: jest.fn(),
      deactivatePattern: jest.fn(),
      getPatternHistory: jest.fn(),
      compileAndSubmitPatterns: jest.fn(),
    };
    mockQuery = jest.fn();

    jest.mocked(getPostgresClient).mockReturnValue({
      query: mockQuery,
    } as unknown as PostgresClient);

    controller = new AIPatternController(
      mockStorage as unknown as PatternStorageService,
      mockAnalyzer as unknown as PatternAnalyzer,
      mockCompiler as unknown as PatternCompiler,
      mockValidator as unknown as PatternValidator,
      mockWorkflow as unknown as PatternWorkflow
    );
  });

  // ==========================================================================
  // listPatterns
  // ==========================================================================

  describe('listPatterns', () => {
    it('forwards parsed filters to the storage service', async () => {
      mockStorage.listPatterns.mockResolvedValue([{ patternId: 'pat-1' }]);
      const req = authedReq({
        query: {
          status: 'draft,review',
          category: 'web',
          isActive: 'true',
          minConfidence: '0.5',
          minUsage: '3',
          search: 'nginx',
        },
      });
      const res = mockRes();

      await controller.listPatterns(req, res);

      expect(mockStorage.listPatterns).toHaveBeenCalledWith({
        status: ['draft', 'review'],
        category: 'web',
        isActive: true,
        minConfidence: 0.5,
        minUsage: 3,
        search: 'nginx',
        limit: undefined,
        offset: undefined,
      });
      expect(bodyOf(res)).toEqual({ success: true, data: [{ patternId: 'pat-1' }] });
    });

    it('rejects an out-of-range limit before querying storage', async () => {
      const req = authedReq({ query: { limit: '5000' } });
      const res = mockRes();

      await controller.listPatterns(req, res);

      expect(statusOf(res)).toBe(400);
      expect(mockStorage.listPatterns).not.toHaveBeenCalled();
    });

    it('accepts a status array (axios status[]=... serialization) without an Array.prototype.toString accident', async () => {
      mockStorage.listPatterns.mockResolvedValue([]);
      const req = authedReq({ query: { status: ['draft', 'review'] } });
      const res = mockRes();

      await controller.listPatterns(req, res);

      expect(mockStorage.listPatterns).toHaveBeenCalledWith(
        expect.objectContaining({ status: ['draft', 'review'] })
      );
    });
  });

  describe('getPattern', () => {
    it('returns 404 for an unknown pattern id', async () => {
      mockStorage.getPattern.mockResolvedValue(null);
      const req = authedReq({ params: { patternId: 'missing' } });
      const res = mockRes();

      await controller.getPattern(req, res);

      expect(statusOf(res)).toBe(404);
    });

    it('returns the pattern when found', async () => {
      mockStorage.getPattern.mockResolvedValue({ patternId: 'pat-1' });
      const req = authedReq({ params: { patternId: 'pat-1' } });
      const res = mockRes();

      await controller.getPattern(req, res);

      expect(bodyOf(res)).toEqual({ success: true, data: { patternId: 'pat-1' } });
    });
  });

  describe('deletePattern', () => {
    it('returns 404 when no pattern matched', async () => {
      mockStorage.deletePattern.mockResolvedValue(false);
      const req = authedReq({ params: { patternId: 'missing' } });
      const res = mockRes();

      await controller.deletePattern(req, res);

      expect(statusOf(res)).toBe(404);
    });

    it('returns 200 when the pattern was deleted', async () => {
      mockStorage.deletePattern.mockResolvedValue(true);
      const req = authedReq({ params: { patternId: 'pat-1' } });
      const res = mockRes();

      await controller.deletePattern(req, res);

      expect(statusOf(res)).toBe(200);
      expect(mockStorage.deletePattern).toHaveBeenCalledWith('pat-1');
    });
  });

  // ==========================================================================
  // Workflow transitions: actor identity + 404/409 mapping
  // ==========================================================================

  describe('submitForReview', () => {
    it('derives the actor from req.user, never the request body', async () => {
      mockWorkflow.submitForReview.mockResolvedValue({ success: true });
      const req = authedReq({
        params: { patternId: 'pat-1' },
        body: { notes: 'ready', submittedBy: 'spoofed-actor' },
        user: { _userId: 'auth-user', _username: 'alice', _role: 'operator', _type: 'access' },
      });
      const res = mockRes();

      await controller.submitForReview(req, res);

      expect(mockWorkflow.submitForReview).toHaveBeenCalledWith('pat-1', 'auth-user', 'ready');
    });

    it('falls back to username, then system, when no user id is present', async () => {
      mockWorkflow.submitForReview.mockResolvedValue({ success: true });
      const req = authedReq({
        params: { patternId: 'pat-1' },
        body: {},
        user: { _username: 'bob', _role: 'operator', _type: 'access' } as never,
      });
      const res = mockRes();

      await controller.submitForReview(req, res);

      expect(mockWorkflow.submitForReview).toHaveBeenCalledWith('pat-1', 'bob', undefined);
    });

    it('maps a "Pattern not found" workflow failure to 404', async () => {
      mockWorkflow.submitForReview.mockResolvedValue({ success: false, error: 'Pattern not found' });
      const req = authedReq({ params: { patternId: 'missing' } });
      const res = mockRes();

      await controller.submitForReview(req, res);

      expect(statusOf(res)).toBe(404);
    });

    it('maps any other workflow failure to 409', async () => {
      mockWorkflow.submitForReview.mockResolvedValue({
        success: false,
        error: 'Pattern status is active, expected draft',
      });
      const req = authedReq({ params: { patternId: 'pat-1' } });
      const res = mockRes();

      await controller.submitForReview(req, res);

      expect(statusOf(res)).toBe(409);
      expect(bodyOf(res)).toMatchObject({
        success: false,
        message: 'Pattern status is active, expected draft',
      });
    });

    it('maps a history-insert rollback (tagged internal failure) to a generic 500, not 409', async () => {
      // Simulates PatternStorageService.transitionPattern() rolling back
      // because the ai_pattern_review_history insert failed: the workflow
      // catches it and returns a tagged, sanitized failure (see
      // PatternWorkflow.submitForReview's catch block) rather than the raw
      // DB error text.
      mockWorkflow.submitForReview.mockResolvedValue({
        success: false,
        internal: true,
        error: 'Internal error while submitting pattern for review',
      });
      const req = authedReq({ params: { patternId: 'pat-1' } });
      const res = mockRes();

      await controller.submitForReview(req, res);

      expect(statusOf(res)).toBe(500);
      const body = bodyOf(res);
      expect(body).toMatchObject({
        success: false,
        error: 'Internal Server Error',
        message: "Failed to process transition for pattern 'pat-1'",
      });
      // The generic controller-level message never echoes DB-specific
      // failure detail (constraint names, table names, driver text).
      expect(JSON.stringify(body)).not.toMatch(/ai_pattern_review_history|constraint|duplicate key/i);
    });
  });

  describe('approvePattern', () => {
    it('derives the approver from req.user and returns 200 on success', async () => {
      mockWorkflow.approvePattern.mockResolvedValue({ success: true });
      const req = authedReq({
        params: { patternId: 'pat-1' },
        body: { approvedBy: 'spoofed' },
        user: { _userId: 'auth-user', _username: 'alice', _role: 'admin', _type: 'access' },
      });
      const res = mockRes();

      await controller.approvePattern(req, res);

      expect(mockWorkflow.approvePattern).toHaveBeenCalledWith('pat-1', 'auth-user', undefined);
      expect(statusOf(res)).toBe(200);
    });
  });

  describe('rejectPattern', () => {
    it('passes the reason through and derives the actor from req.user', async () => {
      mockWorkflow.rejectPattern.mockResolvedValue({ success: true });
      const req = authedReq({
        params: { patternId: 'pat-1' },
        body: { reason: 'security concern', rejectedBy: 'spoofed' },
      });
      const res = mockRes();

      await controller.rejectPattern(req, res);

      expect(mockWorkflow.rejectPattern).toHaveBeenCalledWith('pat-1', 'user-1', 'security concern');
    });
  });

  describe('activatePattern', () => {
    it('returns 409 when the pattern is not in the approved state', async () => {
      mockWorkflow.activatePattern.mockResolvedValue({
        success: false,
        error: 'Pattern status is draft, expected approved',
      });
      const req = authedReq({ params: { patternId: 'pat-1' } });
      const res = mockRes();

      await controller.activatePattern(req, res);

      expect(statusOf(res)).toBe(409);
    });
  });

  describe('deactivatePattern', () => {
    it('returns 200 with the workflow result on success', async () => {
      mockWorkflow.deactivatePattern.mockResolvedValue({ success: true });
      const req = authedReq({ params: { patternId: 'pat-1' }, body: { reason: 'deprecated' } });
      const res = mockRes();

      await controller.deactivatePattern(req, res);

      expect(mockWorkflow.deactivatePattern).toHaveBeenCalledWith('pat-1', 'user-1', 'deprecated');
      expect(bodyOf(res)).toEqual({ success: true, data: { success: true } });
    });
  });

  // ==========================================================================
  // validatePattern / usage / history / compile
  // ==========================================================================

  describe('validatePattern', () => {
    it('returns 404 for an unknown pattern', async () => {
      mockStorage.getPattern.mockResolvedValue(null);
      const req = authedReq({ params: { patternId: 'missing' } });
      const res = mockRes();

      await controller.validatePattern(req, res);

      expect(statusOf(res)).toBe(404);
      expect(mockValidator.validate).not.toHaveBeenCalled();
    });

    it('validates and returns the result for a known pattern', async () => {
      mockStorage.getPattern.mockResolvedValue({ patternId: 'pat-1' });
      mockValidator.validate.mockResolvedValue({ isValid: false, errors: ['bad code'] });
      const req = authedReq({ params: { patternId: 'pat-1' } });
      const res = mockRes();

      await controller.validatePattern(req, res);

      expect(bodyOf(res)).toEqual({ success: true, data: { isValid: false, errors: ['bad code'] } });
    });
  });

  describe('getPatternUsage', () => {
    it('returns 400 when days is out of bounds', async () => {
      mockStorage.getPattern.mockResolvedValue({ patternId: 'pat-1' });
      const req = authedReq({ params: { patternId: 'pat-1' }, query: { days: '9999' } });
      const res = mockRes();

      await controller.getPatternUsage(req, res);

      expect(statusOf(res)).toBe(400);
      expect(mockStorage.getPatternUsage).not.toHaveBeenCalled();
    });

    it('defaults to 30 days and returns usage records', async () => {
      mockStorage.getPattern.mockResolvedValue({ patternId: 'pat-1' });
      mockStorage.getPatternUsage.mockResolvedValue([{ patternId: 'pat-1', success: true }]);
      const req = authedReq({ params: { patternId: 'pat-1' } });
      const res = mockRes();

      await controller.getPatternUsage(req, res);

      expect(mockStorage.getPatternUsage).toHaveBeenCalledWith('pat-1', 30);
    });
  });

  describe('getPatternHistory', () => {
    it('returns 404 for an unknown pattern', async () => {
      mockStorage.getPattern.mockResolvedValue(null);
      const req = authedReq({ params: { patternId: 'missing' } });
      const res = mockRes();

      await controller.getPatternHistory(req, res);

      expect(statusOf(res)).toBe(404);
    });
  });

  describe('compileAndSubmitPatterns', () => {
    it('returns the compilation summary on success', async () => {
      mockWorkflow.compileAndSubmitPatterns.mockResolvedValue({
        compiled: 2,
        submitted: 1,
        errors: ['candidate X failed'],
      });
      const req = authedReq();
      const res = mockRes();

      await controller.compileAndSubmitPatterns(req, res);

      expect(bodyOf(res)).toEqual({
        success: true,
        data: { compiled: 2, submitted: 1, errors: ['candidate X failed'] },
      });
    });

    it('returns 500 when the workflow throws', async () => {
      mockWorkflow.compileAndSubmitPatterns.mockRejectedValue(new Error('compiler exploded'));
      const req = authedReq();
      const res = mockRes();

      await controller.compileAndSubmitPatterns(req, res);

      expect(statusOf(res)).toBe(500);
      expect(bodyOf(res)).toMatchObject({ success: false, message: 'compiler exploded' });
    });
  });

  // ==========================================================================
  // Sessions
  // ==========================================================================

  describe('listSessions', () => {
    it('filters by aiModel instead of a nonexistent provider column, excluding synthetic sessions by default', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const req = authedReq({ query: { aiModel: 'claude-sonnet-4.5', status: 'completed' } });
      const res = mockRes();

      await controller.listSessions(req, res);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('ai_model = $2');
      expect(sql).toContain('status = ANY($1)');
      expect(sql).toContain('ai_model <> $3');
      expect(params).toEqual([['completed'], 'claude-sonnet-4.5', 'pattern-matcher', 100, 0]);
    });

    it('accepts a status array (axios status[]=... serialization) alongside a comma-separated string', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const req = authedReq({ query: { status: ['completed', 'failed'] } });
      const res = mockRes();

      await controller.listSessions(req, res);

      const [, params] = mockQuery.mock.calls[0];
      expect(params[0]).toEqual(['completed', 'failed']);
    });

    it('includes synthetic pattern-matcher sessions only when includeSynthetic=true', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const req = authedReq({ query: { includeSynthetic: 'true' } });
      const res = mockRes();

      await controller.listSessions(req, res);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).not.toContain('ai_model <>');
      expect(params).not.toContain('pattern-matcher');
    });

    it('rejects an out-of-range limit', async () => {
      const req = authedReq({ query: { limit: '0' } });
      const res = mockRes();

      await controller.listSessions(req, res);

      expect(statusOf(res)).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('getSession', () => {
    it('returns 404 when no session matches', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const req = authedReq({ params: { sessionId: 'missing' } });
      const res = mockRes();

      await controller.getSession(req, res);

      expect(statusOf(res)).toBe(404);
    });

    it('excludes synthetic pattern-matcher sessions from direct lookup (404s exactly like an unknown id)', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const req = authedReq({ params: { sessionId: 'synthetic-session' } });
      const res = mockRes();

      await controller.getSession(req, res);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('ai_model <> $2');
      expect(params).toEqual(['synthetic-session', 'pattern-matcher']);
      expect(statusOf(res)).toBe(404);
    });
  });

  describe('analyzeSession', () => {
    it('returns 404 for an unknown session', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      const req = authedReq({ params: { sessionId: 'missing' } });
      const res = mockRes();

      await controller.analyzeSession(req, res);

      expect(statusOf(res)).toBe(404);
      expect(mockAnalyzer.analyzeSession).not.toHaveBeenCalled();
    });

    it('maps the row and delegates to the analyzer', async () => {
      mockQuery.mockResolvedValue({
        rows: [
          {
            id: 'row-1',
            session_id: 'sess-1',
            target_host: '10.0.0.1',
            target_port: 443,
            status: 'completed',
            started_at: new Date('2026-01-01'),
            completed_at: new Date('2026-01-01'),
            duration_ms: 500,
            ai_model: 'claude-sonnet-4.5',
            total_tokens: 100,
            prompt_tokens: 60,
            completion_tokens: 40,
            estimated_cost: '0.01',
            discovered_cis: [],
            confidence_score: 0.9,
            tool_calls: [],
            ai_reasoning: null,
            pattern_matched: null,
            error_message: null,
            retry_count: 0,
          },
        ],
      });
      mockAnalyzer.analyzeSession.mockResolvedValue({ isPattern: false, signature: null, candidate: null });
      const req = authedReq({ params: { sessionId: 'sess-1' } });
      const res = mockRes();

      await controller.analyzeSession(req, res);

      expect(mockAnalyzer.analyzeSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-1', aiModel: 'claude-sonnet-4.5', estimatedCost: 0.01 })
      );
      expect(bodyOf(res)).toEqual({
        success: true,
        data: { isPattern: false, signature: null, candidate: null },
      });
    });
  });

  // ==========================================================================
  // Analytics
  // ==========================================================================

  describe('getCostAnalytics', () => {
    it('excludes pattern-matcher synthetic sessions and computes real savings', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ total_cost: '10.00', total_sessions: '5', avg_cost_per_session: '2.00' }],
        })
        .mockResolvedValueOnce({ rows: [{ ai_model: 'claude-sonnet-4.5', cost: '10.00', sessions: '5' }] })
        .mockResolvedValueOnce({ rows: [{ date: '2026-01-01', cost: '10.00', sessions: '5' }] })
        .mockResolvedValueOnce({ rows: [{ pattern_hits: '15' }] });

      const req = authedReq();
      const res = mockRes();

      await controller.getCostAnalytics(req, res);

      const [firstSql, firstParams] = mockQuery.mock.calls[0];
      expect(firstSql).toContain("ai_model <> $1");
      expect(firstParams).toEqual(['pattern-matcher', null, null]);

      const [costByDaySql] = mockQuery.mock.calls[2];
      expect(costByDaySql).toContain('DATE(started_at)::text as date');

      const body = bodyOf(res);
      expect(body).toEqual({
        success: true,
        data: {
          totalCost: 10,
          totalSessions: 5,
          avgCostPerSession: 2,
          costByModel: [{ aiModel: 'claude-sonnet-4.5', cost: 10, sessions: 5 }],
          costByDay: [{ date: '2026-01-01', cost: 10, sessions: 5 }],
          savingsFromPatterns: {
            totalSaved: 30, // 15 pattern hits * $2 avg cost per AI session
            percentSaved: 75, // 15 / (15 + 5) * 100
            patternHits: 15,
            aiDiscoveries: 5,
          },
        },
      });
    });

    it('reverses the DESC-ordered costByDay rows into chronological (oldest-to-newest) order with bare date strings', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ total_cost: '30.00', total_sessions: '3', avg_cost_per_session: '10.00' }],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({
          rows: [
            { date: '2026-01-03', cost: '5.00', sessions: '1' },
            { date: '2026-01-02', cost: '10.00', sessions: '1' },
            { date: '2026-01-01', cost: '15.00', sessions: '1' },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ pattern_hits: '0' }] });

      const req = authedReq();
      const res = mockRes();

      await controller.getCostAnalytics(req, res);

      const body = bodyOf(res) as { data: { costByDay: Array<{ date: string; cost: number; sessions: number }> } };
      expect(body.data.costByDay).toEqual([
        { date: '2026-01-01', cost: 15, sessions: 1 },
        { date: '2026-01-02', cost: 10, sessions: 1 },
        { date: '2026-01-03', cost: 5, sessions: 1 },
      ]);
      for (const entry of body.data.costByDay) {
        expect(typeof entry.date).toBe('string');
        expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  });

  describe('getLearningStats', () => {
    it('computes auto vs manual approvals from the review history table', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [
            {
              active_patterns: '3',
              pending_review: '1',
              total_patterns: '10',
              avg_confidence: '0.87',
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [{ total_sessions: '42' }] })
        .mockResolvedValueOnce({ rows: [{ auto_approved: '4', manual_approved: '2' }] });

      const req = authedReq();
      const res = mockRes();

      await controller.getLearningStats(req, res);

      expect(bodyOf(res)).toEqual({
        success: true,
        data: {
          totalPatterns: 10,
          activePatterns: 3,
          pendingReview: 1,
          autoApproved: 4,
          manualApproved: 2,
          totalSessions: 42,
          avgConfidence: 0.87,
        },
      });
    });
  });
});
