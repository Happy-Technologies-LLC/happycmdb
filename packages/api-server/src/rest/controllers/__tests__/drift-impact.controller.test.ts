// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for DriftImpactController
 *
 * Covers the REST contract layered on top of ConfigurationDriftDetector and
 * ImpactPredictionEngine: baseline-absent, no-drift, critical-drift,
 * unknown-CI, and bounded-graph handling.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Response } from 'express';

jest.mock('@cmdb/common', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: jest.fn(),
  getPostgresClient: jest.fn(),
}));

jest.mock('@cmdb/ai-ml-engine', () => ({
  ...(jest.requireActual('@cmdb/ai-ml-engine') as object),
  getConfigurationDriftDetector: jest.fn(),
  getImpactPredictionEngine: jest.fn(),
}));

import { getNeo4jClient } from '@cmdb/database';
import { getConfigurationDriftDetector, getImpactPredictionEngine } from '@cmdb/ai-ml-engine';
import { DriftImpactController } from '../drift-impact.controller';
import type { AuthenticatedRequest } from '../../../middleware/auth.middleware';

function mockRes(): Response {
  const res: Partial<Response> = {
    status: jest.fn().mockReturnThis() as unknown as Response['status'],
    json: jest.fn().mockReturnThis() as unknown as Response['json'],
  };
  return res as Response;
}

describe('DriftImpactController', () => {
  let controller: DriftImpactController;
  // Mock typing follows this suite's established convention (see
  // itil-status-casing.test.ts's `jest.Mock<any, any[]>`): jest's default
  // Mock generics otherwise infer `never` for the resolved-value parameter.
  let mockNeo4jClient: { getCI: jest.Mock<any, any> };
  let mockDriftDetector: {
    getApprovedBaseline: jest.Mock<any, any>;
    detectDrift: jest.Mock<any, any>;
    getDriftHistory: jest.Mock<any, any>;
    createBaseline: jest.Mock<any, any>;
    approveBaseline: jest.Mock<any, any>;
    getBaselineById: jest.Mock<any, any>;
  };
  let mockImpactEngine: {
    predictChangeImpact: jest.Mock<any, any>;
    buildDependencyGraph: jest.Mock<any, any>;
    getCriticalityScore: jest.Mock<any, any>;
    getImpactHistory: jest.Mock<any, any>;
  };

  beforeEach(() => {
    mockNeo4jClient = { getCI: jest.fn() };
    mockDriftDetector = {
      getApprovedBaseline: jest.fn(),
      detectDrift: jest.fn(),
      getDriftHistory: jest.fn(),
      createBaseline: jest.fn(),
      approveBaseline: jest.fn(),
      getBaselineById: jest.fn(),
    };
    mockImpactEngine = {
      predictChangeImpact: jest.fn(),
      buildDependencyGraph: jest.fn(),
      getCriticalityScore: jest.fn(),
      getImpactHistory: jest.fn(),
    };

    (getNeo4jClient as jest.Mock).mockReturnValue(mockNeo4jClient);
    (getConfigurationDriftDetector as jest.Mock).mockReturnValue(mockDriftDetector);
    (getImpactPredictionEngine as jest.Mock).mockReturnValue(mockImpactEngine);

    controller = new DriftImpactController();
  });

  describe('detectDrift', () => {
    it('returns 404 when the CI does not exist', async () => {
      mockNeo4jClient.getCI.mockResolvedValue(null);

      const req = { params: { ciId: 'ci-missing' } } as unknown as AuthenticatedRequest;
      const res = mockRes();

      await controller.detectDrift(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockDriftDetector.getApprovedBaseline).not.toHaveBeenCalled();
    });

    it('returns 404 when no approved baseline exists for the CI', async () => {
      mockNeo4jClient.getCI.mockResolvedValue({ id: 'ci-001', name: 'web-01' });
      mockDriftDetector.getApprovedBaseline.mockResolvedValue(null);

      const req = { params: { ciId: 'ci-001' } } as unknown as AuthenticatedRequest;
      const res = mockRes();

      await controller.detectDrift(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: expect.stringContaining('No approved configuration baseline'),
        })
      );
      expect(mockDriftDetector.detectDrift).not.toHaveBeenCalled();
    });

    it('returns the drift result when there is no drift', async () => {
      mockNeo4jClient.getCI.mockResolvedValue({ id: 'ci-001', name: 'web-01' });
      mockDriftDetector.getApprovedBaseline.mockResolvedValue({ id: 'baseline-1' });
      mockDriftDetector.detectDrift.mockResolvedValue({
        ci_id: 'ci-001',
        ci_name: 'web-01',
        has_drift: false,
        drift_score: 0,
        drifted_fields: [],
        baseline_snapshot_id: 'baseline-1',
        detected_at: '2026-01-01T00:00:00.000Z',
      });

      const req = { params: { ciId: 'ci-001' } } as unknown as AuthenticatedRequest;
      const res = mockRes();

      await controller.detectDrift(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ has_drift: false, drift_score: 0 }),
        })
      );
    });

    it('returns the drift result for critical drift', async () => {
      mockNeo4jClient.getCI.mockResolvedValue({ id: 'ci-001', name: 'web-01' });
      mockDriftDetector.getApprovedBaseline.mockResolvedValue({ id: 'baseline-1' });
      mockDriftDetector.detectDrift.mockResolvedValue({
        ci_id: 'ci-001',
        ci_name: 'web-01',
        has_drift: true,
        drift_score: 90,
        drifted_fields: [
          {
            field_name: 'ip_address',
            baseline_value: '10.0.0.1',
            current_value: '10.0.0.2',
            change_type: 'modified',
            severity: 'critical',
          },
        ],
        baseline_snapshot_id: 'baseline-1',
        detected_at: '2026-01-01T00:00:00.000Z',
      });

      const req = { params: { ciId: 'ci-001' } } as unknown as AuthenticatedRequest;
      const res = mockRes();

      await controller.detectDrift(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ has_drift: true, drift_score: 90 }),
        })
      );
      const [payload] = (res.json as jest.Mock).mock.calls[0] as [{ data: { drifted_fields: unknown[] } }];
      expect(payload.data.drifted_fields).toHaveLength(1);
    });
  });

  describe('createBaseline', () => {
    it('derives the baseline creator from req.user, never the request body', async () => {
      mockNeo4jClient.getCI.mockResolvedValue({ id: 'ci-001', name: 'web-01' });
      mockDriftDetector.createBaseline.mockResolvedValue({ id: 'baseline-1', created_by: 'auth-user' });

      const req = {
        body: {
          ci_id: 'ci-001',
          snapshot_type: 'configuration',
          created_by: 'spoofed-user',
        },
        user: { _userId: 'auth-user' },
      } as unknown as AuthenticatedRequest;
      const res = mockRes();

      await controller.createBaseline(req, res);

      expect(mockDriftDetector.createBaseline).toHaveBeenCalledWith(
        'ci-001',
        'configuration',
        'auth-user'
      );
    });
  });

  describe('approveBaseline', () => {
    it('returns 404 for an unknown baseline id', async () => {
      mockDriftDetector.getBaselineById.mockResolvedValue(null);

      const req = { params: { baselineId: 'baseline-missing' } } as unknown as AuthenticatedRequest;
      const res = mockRes();

      await controller.approveBaseline(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockDriftDetector.approveBaseline).not.toHaveBeenCalled();
    });

    it('derives the approver from req.user, never the request body', async () => {
      mockDriftDetector.getBaselineById.mockResolvedValue({ id: 'baseline-1' });
      mockDriftDetector.approveBaseline.mockResolvedValue({
        id: 'baseline-1',
        is_approved: true,
        approved_by: 'auth-user',
      });

      const req = {
        params: { baselineId: 'baseline-1' },
        body: { approved_by: 'spoofed-user' },
        user: { _userId: 'auth-user' },
      } as unknown as AuthenticatedRequest;
      const res = mockRes();

      await controller.approveBaseline(req, res);

      expect(mockDriftDetector.approveBaseline).toHaveBeenCalledWith('baseline-1', 'auth-user');
    });
  });

  describe('predictImpact', () => {
    it('returns 404 for an unknown CI', async () => {
      mockNeo4jClient.getCI.mockResolvedValue(null);

      const req = {
        body: { ci_id: 'ci-missing', change_type: 'RESTART' },
      } as unknown as AuthenticatedRequest;
      const res = mockRes();

      await controller.predictImpact(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockImpactEngine.predictChangeImpact).not.toHaveBeenCalled();
    });

    it('rejects an invalid change_type before touching the engine', async () => {
      const req = {
        body: { ci_id: 'ci-001', change_type: 'NOT_A_REAL_CHANGE' },
      } as unknown as AuthenticatedRequest;
      const res = mockRes();

      await controller.predictImpact(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockNeo4jClient.getCI).not.toHaveBeenCalled();
      expect(mockImpactEngine.predictChangeImpact).not.toHaveBeenCalled();
    });

    it('normalizes the UI-cased change_type and predicts impact', async () => {
      mockNeo4jClient.getCI.mockResolvedValue({ id: 'ci-001', name: 'db-01' });
      mockImpactEngine.predictChangeImpact.mockResolvedValue({
        id: 'impact-1',
        source_ci_id: 'ci-001',
        source_ci_name: 'db-01',
        change_type: 'restart',
        impact_score: 42,
        affected_cis: [],
        blast_radius: 0,
        critical_path: ['ci-001'],
        risk_level: 'low',
        analyzed_at: '2026-01-01T00:00:00.000Z',
      });

      const req = {
        body: { ci_id: 'ci-001', change_type: 'RESTART' },
      } as unknown as AuthenticatedRequest;
      const res = mockRes();

      await controller.predictImpact(req, res);

      expect(mockImpactEngine.predictChangeImpact).toHaveBeenCalledWith('ci-001', 'restart');
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  describe('getDependencyGraph', () => {
    it('returns 404 for an unknown root CI', async () => {
      mockNeo4jClient.getCI.mockResolvedValue(null);

      const req = { params: { rootCiId: 'ci-missing' }, query: {} } as unknown as AuthenticatedRequest;
      const res = mockRes();

      await controller.getDependencyGraph(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(mockImpactEngine.buildDependencyGraph).not.toHaveBeenCalled();
    });

    it('rejects a max_depth above the bound without calling the engine', async () => {
      mockNeo4jClient.getCI.mockResolvedValue({ id: 'ci-001', name: 'db-01' });

      const req = {
        params: { rootCiId: 'ci-001' },
        query: { max_depth: '25' },
      } as unknown as AuthenticatedRequest;
      const res = mockRes();

      await controller.getDependencyGraph(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockImpactEngine.buildDependencyGraph).not.toHaveBeenCalled();
    });

    it('rejects a max_depth below the bound without calling the engine', async () => {
      const req = {
        params: { rootCiId: 'ci-001' },
        query: { max_depth: '0' },
      } as unknown as AuthenticatedRequest;
      const res = mockRes();

      await controller.getDependencyGraph(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockNeo4jClient.getCI).not.toHaveBeenCalled();
      expect(mockImpactEngine.buildDependencyGraph).not.toHaveBeenCalled();
    });

    it('passes the validated max_depth through to buildDependencyGraph', async () => {
      mockNeo4jClient.getCI.mockResolvedValue({ id: 'ci-001', name: 'db-01' });
      mockImpactEngine.buildDependencyGraph.mockResolvedValue({
        nodes: [],
        edges: [],
        metadata: { total_nodes: 0, total_edges: 0, max_depth: 4, generated_at: '2026-01-01T00:00:00.000Z' },
      });

      const req = {
        params: { rootCiId: 'ci-001' },
        query: { max_depth: '4' },
      } as unknown as AuthenticatedRequest;
      const res = mockRes();

      await controller.getDependencyGraph(req, res);

      expect(mockImpactEngine.buildDependencyGraph).toHaveBeenCalledWith('ci-001', 4);
      expect(res.status).not.toHaveBeenCalledWith(400);
    });
  });
});
