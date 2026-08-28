// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift & Impact Controller
 *
 * REST API controller backing the Configuration Drift Detection and
 * Change Impact Prediction UI. Delegates all calculation to the
 * ConfigurationDriftDetector and ImpactPredictionEngine services in
 * @cmdb/ai-ml-engine - this controller only validates requests, resolves
 * CI existence, and maps engine results onto HTTP responses.
 */

import { Response } from 'express';
import { getNeo4jClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import {
  getConfigurationDriftDetector,
  getImpactPredictionEngine,
  ChangeType,
} from '@cmdb/ai-ml-engine';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';

type SnapshotType = 'configuration' | 'performance' | 'relationships';

const SNAPSHOT_TYPES: SnapshotType[] = ['configuration', 'performance', 'relationships'];

function isSnapshotType(value: string): value is SnapshotType {
  return (SNAPSHOT_TYPES as string[]).includes(value);
}

function isChangeType(value: string): value is ChangeType {
  return (Object.values(ChangeType) as string[]).includes(value);
}

export class DriftImpactController {
  private neo4jClient = getNeo4jClient();
  private driftDetector = getConfigurationDriftDetector();
  private impactEngine = getImpactPredictionEngine();

  /**
   * Resolve the authenticated actor for audit fields (created_by/approved_by).
   * Mutation bodies are never trusted for identity - only req.user is authoritative.
   */
  private getActor(req: AuthenticatedRequest): string {
    return req.user?._userId || req.user?._username || 'system';
  }

  // ==========================================================================
  // Drift
  // ==========================================================================

  /**
   * Detect configuration drift for a CI against its approved baseline
   * POST /drift/detect/:ciId
   */
  async detectDrift(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { ciId } = req.params;
      if (!ciId) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'CI ID is required',
        });
        return;
      }

      const ci = await this.neo4jClient.getCI(ciId);
      if (!ci) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `CI with ID '${ciId}' not found`,
        });
        return;
      }

      const baseline = await this.driftDetector.getApprovedBaseline(ciId, 'configuration');
      if (!baseline) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `No approved configuration baseline found for CI '${ciId}'. Create and approve a baseline before detecting drift.`,
        });
        return;
      }

      const result = await this.driftDetector.detectDrift(ciId);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('Error detecting configuration drift', error);
      res.status(500).json({
        success: false,
        error: 'Failed to detect configuration drift',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get drift detection history for a CI
   * GET /drift/history/:ciId
   */
  async getDriftHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { ciId } = req.params;
      if (!ciId) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'CI ID is required',
        });
        return;
      }

      const { limit = 50 } = req.query;
      const limitNum = parseInt(String(limit), 10);
      if (isNaN(limitNum) || limitNum < 1 || limitNum > 500) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Limit must be a number between 1 and 500',
        });
        return;
      }

      const history = await this.driftDetector.getDriftHistory(ciId, limitNum);

      res.json({
        success: true,
        data: history,
      });
    } catch (error) {
      logger.error('Error retrieving drift history', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve drift history',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Create a baseline snapshot for a CI
   * POST /drift/baseline
   */
  async createBaseline(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { ci_id, snapshot_type } = req.body;

      if (!isSnapshotType(String(snapshot_type))) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `snapshot_type must be one of: ${SNAPSHOT_TYPES.join(', ')}`,
        });
        return;
      }

      const ci = await this.neo4jClient.getCI(ci_id);
      if (!ci) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `CI with ID '${ci_id}' not found`,
        });
        return;
      }

      const baseline = await this.driftDetector.createBaseline(
        ci_id,
        snapshot_type,
        this.getActor(req)
      );

      res.status(201).json({
        success: true,
        data: baseline,
        message: 'Baseline snapshot created successfully',
      });
    } catch (error) {
      logger.error('Error creating baseline snapshot', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create baseline snapshot',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Approve a baseline snapshot
   * POST /drift/baseline/:baselineId/approve
   */
  async approveBaseline(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { baselineId } = req.params;
      if (!baselineId) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Baseline ID is required',
        });
        return;
      }

      const existing = await this.driftDetector.getBaselineById(baselineId);
      if (!existing) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Baseline snapshot with ID '${baselineId}' not found`,
        });
        return;
      }

      const approved = await this.driftDetector.approveBaseline(baselineId, this.getActor(req));

      res.json({
        success: true,
        data: approved,
        message: 'Baseline approved successfully',
      });
    } catch (error) {
      logger.error('Error approving baseline snapshot', error);
      res.status(500).json({
        success: false,
        error: 'Failed to approve baseline snapshot',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get the currently approved baseline for a CI
   * GET /drift/baseline/:ciId
   */
  async getApprovedBaseline(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { ciId } = req.params;
      if (!ciId) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'CI ID is required',
        });
        return;
      }

      const requestedType = String(req.query['snapshot_type'] || 'configuration');
      if (!isSnapshotType(requestedType)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `snapshot_type must be one of: ${SNAPSHOT_TYPES.join(', ')}`,
        });
        return;
      }

      const baseline = await this.driftDetector.getApprovedBaseline(ciId, requestedType);

      res.json({
        success: true,
        data: baseline,
      });
    } catch (error) {
      logger.error('Error retrieving approved baseline', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve approved baseline',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // ==========================================================================
  // Impact
  // ==========================================================================

  /**
   * Predict the impact of a change on a CI
   * POST /impact/predict
   */
  async predictImpact(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { ci_id, change_type } = req.body;

      const normalizedChangeType = String(change_type).toLowerCase();
      if (!isChangeType(normalizedChangeType)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `change_type must be one of: ${Object.values(ChangeType).join(', ')}`,
        });
        return;
      }

      const ci = await this.neo4jClient.getCI(ci_id);
      if (!ci) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `CI with ID '${ci_id}' not found`,
        });
        return;
      }

      const impact = await this.impactEngine.predictChangeImpact(ci_id, normalizedChangeType);

      res.status(201).json({
        success: true,
        data: impact,
      });
    } catch (error) {
      logger.error('Error predicting change impact', error);
      res.status(500).json({
        success: false,
        error: 'Failed to predict change impact',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Build a bounded dependency graph rooted at a CI
   * GET /impact/graph/:rootCiId
   */
  async getDependencyGraph(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { rootCiId } = req.params;
      if (!rootCiId) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Root CI ID is required',
        });
        return;
      }

      const { max_depth = 3 } = req.query;
      const maxDepth = parseInt(String(max_depth), 10);
      if (isNaN(maxDepth) || maxDepth < 1 || maxDepth > 5) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'max_depth must be a number between 1 and 5',
        });
        return;
      }

      const ci = await this.neo4jClient.getCI(rootCiId);
      if (!ci) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `CI with ID '${rootCiId}' not found`,
        });
        return;
      }

      const graph = await this.impactEngine.buildDependencyGraph(rootCiId, maxDepth);

      res.json({
        success: true,
        data: graph,
      });
    } catch (error) {
      logger.error('Error building dependency graph', error);
      res.status(500).json({
        success: false,
        error: 'Failed to build dependency graph',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get the criticality score for a CI
   * GET /impact/criticality/:ciId
   */
  async getCriticalityScore(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { ciId } = req.params;
      if (!ciId) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'CI ID is required',
        });
        return;
      }

      const ci = await this.neo4jClient.getCI(ciId);
      if (!ci) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `CI with ID '${ciId}' not found`,
        });
        return;
      }

      const score = await this.impactEngine.getCriticalityScore(ciId);

      res.json({
        success: true,
        data: score,
      });
    } catch (error) {
      logger.error('Error retrieving criticality score', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve criticality score',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get impact analysis history for a CI
   * GET /impact/history/:ciId
   */
  async getImpactHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { ciId } = req.params;
      if (!ciId) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'CI ID is required',
        });
        return;
      }

      const { limit = 20 } = req.query;
      const limitNum = parseInt(String(limit), 10);
      if (isNaN(limitNum) || limitNum < 1 || limitNum > 200) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Limit must be a number between 1 and 200',
        });
        return;
      }

      const history = await this.impactEngine.getImpactHistory(ciId, limitNum);

      res.json({
        success: true,
        data: history,
      });
    } catch (error) {
      logger.error('Error retrieving impact history', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve impact history',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
