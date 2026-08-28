// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for PatternWorkflow's transition methods: they must route
 * status/approval-field changes and their audit row through
 * PatternStorageService.transitionPattern() as a single atomic call (never
 * the old separate updatePattern()+recordReviewAction() pair), and any
 * failure from that atomic call must surface as a tagged `internal`
 * failure with a generic message -- never the raw error/DB text -- so the
 * REST controller can map it to a 500 instead of the 409 used for
 * expected guard/validation rejections.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@cmdb/common', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@cmdb/database', () => ({
  getPostgresClient: jest.fn(() => ({
    getClient: jest.fn(),
    query: jest.fn(),
    transaction: jest.fn(),
  })),
}));

import { PatternWorkflow } from '../pattern-workflow';
import type { PatternStorageService } from '../pattern-storage';
import type { PatternValidator } from '../pattern-validator';
import type { PatternCompiler } from '../pattern-compiler';
import type { DiscoveryPattern } from '../types';

function draftPattern(overrides: Partial<DiscoveryPattern> = {}): DiscoveryPattern {
  return {
    id: 'row-1',
    patternId: 'pat-1',
    name: 'Test Pattern',
    version: '1.0.0',
    category: 'web',
    detectionCode: 'return true;',
    discoveryCode: 'return [];',
    description: '',
    author: 'tester',
    license: 'MIT',
    confidenceScore: 0.9,
    usageCount: 0,
    successCount: 0,
    failureCount: 0,
    avgExecutionTimeMs: 0,
    learnedFromSessions: [],
    aiModel: 'test-model',
    status: 'draft',
    isActive: false,
    registryUrl: undefined,
    communityUpvotes: 0,
    communityDownvotes: 0,
    testCases: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    approvedAt: undefined,
    approvedBy: undefined,
    ...overrides,
  } as DiscoveryPattern;
}

describe('PatternWorkflow transitions', () => {
  let mockStorage: {
    getPattern: jest.Mock<(patternId: string) => Promise<DiscoveryPattern | null>>;
    transitionPattern: jest.Mock<(...args: unknown[]) => Promise<void>>;
    updatePattern: jest.Mock<(...args: unknown[]) => Promise<void>>;
    recordReviewAction: jest.Mock<(...args: unknown[]) => Promise<void>>;
  };
  let mockValidator: {
    validate: jest.Mock<(...args: unknown[]) => Promise<{ isValid: boolean; errors: string[] }>>;
    quickValidate: jest.Mock<
      (...args: unknown[]) => Promise<{ isValid: boolean; errors: string[] }>
    >;
  };
  let workflow: PatternWorkflow;

  beforeEach(() => {
    mockStorage = {
      getPattern: jest.fn(),
      transitionPattern: jest.fn(),
      updatePattern: jest.fn(),
      recordReviewAction: jest.fn(),
    };
    mockValidator = {
      validate: jest.fn(),
      quickValidate: jest.fn(),
    };
    workflow = new PatternWorkflow(
      mockStorage as unknown as PatternStorageService,
      mockValidator as unknown as PatternValidator,
      {} as unknown as PatternCompiler
    );
  });

  describe('submitForReview', () => {
    it('makes a single atomic transitionPattern call, never separate updatePattern/recordReviewAction calls', async () => {
      mockStorage.getPattern.mockResolvedValue(draftPattern({ status: 'draft' }));
      mockValidator.validate.mockResolvedValue({ isValid: true, errors: [] });
      mockStorage.transitionPattern.mockResolvedValue(undefined);
      const result = await workflow.submitForReview('pat-1', 'alice', 'ready');

      expect(result.success).toBe(true);
      expect(mockStorage.transitionPattern).toHaveBeenCalledTimes(1);
      expect(mockStorage.transitionPattern).toHaveBeenCalledWith(
        'pat-1',
        { status: 'review' },
        'submit',
        'alice',
        'ready'
      );
      expect(mockStorage.updatePattern).not.toHaveBeenCalled();
      expect(mockStorage.recordReviewAction).not.toHaveBeenCalled();
    });

    it('reports a tagged internal failure -- not a raw DB error -- when the atomic transition rolls back', async () => {
      mockStorage.getPattern.mockResolvedValue(draftPattern({ status: 'draft' }));
      mockValidator.validate.mockResolvedValue({ isValid: true, errors: [] });
      mockStorage.transitionPattern.mockRejectedValue(
        new Error(
          'duplicate key value violates unique constraint "ai_pattern_review_history_pkey"'
        )
      );

      const result = await workflow.submitForReview('pat-1', 'alice', 'ready');

      expect(result).toEqual({
        success: false,
        internal: true,
        error: 'Internal error while submitting pattern for review',
      });
      expect(result.error).not.toMatch(/constraint/i);
    });
  });

  describe('approvePattern', () => {
    it('makes a single atomic transitionPattern call carrying the approval fields', async () => {
      mockStorage.getPattern.mockResolvedValue(draftPattern({ status: 'review' }));
      mockValidator.quickValidate.mockResolvedValue({ isValid: true, errors: [] });
      mockStorage.transitionPattern.mockResolvedValue(undefined);

      const result = await workflow.approvePattern('pat-1', 'bob', 'ship it');

      expect(result).toEqual({ success: true });
      expect(mockStorage.transitionPattern).toHaveBeenCalledTimes(1);
      expect(mockStorage.transitionPattern).toHaveBeenCalledWith(
        'pat-1',
        { status: 'approved', approvedBy: 'bob', approvedAt: expect.any(Date) },
        'approve',
        'bob',
        'ship it'
      );
      expect(mockStorage.updatePattern).not.toHaveBeenCalled();
      expect(mockStorage.recordReviewAction).not.toHaveBeenCalled();
    });

    it('never reports success after a failed atomic transition (no partial mutation)', async () => {
      mockStorage.getPattern.mockResolvedValue(draftPattern({ status: 'review' }));
      mockValidator.quickValidate.mockResolvedValue({ isValid: true, errors: [] });
      mockStorage.transitionPattern.mockRejectedValue(new Error('connection terminated'));

      const result = await workflow.approvePattern('pat-1', 'bob', 'ship it');

      expect(result.success).toBe(false);
      expect(result.internal).toBe(true);
      expect(result.error).toBe('Internal error while approving pattern');
      expect(result.error).not.toMatch(/connection terminated/);
    });
  });

  describe('deactivatePattern', () => {
    it('threads the reason through as the transitionPattern comment', async () => {
      mockStorage.getPattern.mockResolvedValue(
        draftPattern({ status: 'active', isActive: true })
      );
      mockStorage.transitionPattern.mockResolvedValue(undefined);

      const result = await workflow.deactivatePattern('pat-1', 'carol', 'superseded');

      expect(result).toEqual({ success: true });
      expect(mockStorage.transitionPattern).toHaveBeenCalledWith(
        'pat-1',
        { status: 'deprecated', isActive: false },
        'deactivate',
        'carol',
        'superseded'
      );
    });
  });
});
