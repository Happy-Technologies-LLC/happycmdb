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
  type BaselineSnapshot,
  type ImpactAnalysis,
} from '@cmdb/ai-ml-engine';
import { AuthenticatedRequest, requestOrganizationId } from '../../middleware/auth.middleware';

type SnapshotType = 'configuration' | 'performance' | 'relationships';

const SNAPSHOT_TYPES: SnapshotType[] = ['configuration', 'performance', 'relationships'];

function isSnapshotType(value: string): value is SnapshotType {
  return (SNAPSHOT_TYPES as string[]).includes(value);
}

function isChangeType(value: string): value is ChangeType {
  return (Object.values(ChangeType) as string[]).includes(value);
}

/**
 * The 404 for a CI that is missing or belongs to another organization: the
 * body only echoes the requested id, so the two cases are indistinguishable.
 */
function sendCINotFound(res: Response, ciId: string): void {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `CI with ID '${ciId}' not found`,
  });
}

// Impact analyses and relationship baselines are stored per CI id together with
// the CI lists they found. Rows written before tenant scoping can name other
// organizations' CIs. `own` is the subset of the CI ids a response would name
// that are CIs of the caller's organization (organizationCIIdsAmong: one
// bounded lookup of only those ids, none when there are none).

/** Every CI id an impact analysis names. */
function impactAnalysisCIIds(analysis: ImpactAnalysis): string[] {
  return [
    ...(analysis.critical_path ?? []),
    ...(analysis.affected_cis ?? []).flatMap(ci => [ci.ci_id, ...(ci.dependency_path ?? [])]),
  ];
}

/** The related-CI entries of a relationships baseline ([] for other snapshot types). */
function relationshipEntries(baseline: BaselineSnapshot | null): Array<{ ci_id?: unknown }> {
  if (baseline === null || baseline.snapshot_type !== 'relationships') return [];
  return ['outgoing', 'incoming'].flatMap(key => {
    const entries: unknown = baseline.snapshot_data[key];
    return Array.isArray(entries) ? entries : [];
  });
}

/** Every CI id a relationships baseline lists. */
function baselineCIIds(baseline: BaselineSnapshot | null): string[] {
  return relationshipEntries(baseline).flatMap(rel => (typeof rel?.ci_id === 'string' ? [rel.ci_id] : []));
}

/**
 * Whether every CI an impact analysis found is in `own`, as for every analysis
 * computed with tenant scoping. One that is not was computed across
 * organizations, and its scores, blast radius and downtime estimate count
 * foreign CIs, so it is not served at all.
 */
function isImpactAnalysisInOrganization(analysis: ImpactAnalysis, own: Set<string>): boolean {
  return (analysis.critical_path ?? []).every(id => own.has(id)) &&
    (analysis.affected_cis ?? []).every(ci => own.has(ci.ci_id) && (ci.dependency_path ?? []).every(id => own.has(id)));
}

/** A baseline whose relationships snapshot only lists CIs in `own` (it holds no derived counts). */
function baselineInOrganization(baseline: BaselineSnapshot | null, own: Set<string>): BaselineSnapshot | null {
  if (baseline === null || baseline.snapshot_type !== 'relationships') return baseline;
  const keep = (related: unknown) => (Array.isArray(related) ? related.filter(rel => own.has(rel?.ci_id)) : related);
  return {
    ...baseline,
    snapshot_data: {
      ...baseline.snapshot_data,
      outgoing: keep(baseline.snapshot_data['outgoing']),
      incoming: keep(baseline.snapshot_data['incoming']),
    },
  };
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

      const organizationId = requestOrganizationId(req);
      if (!(await this.neo4jClient.getCI(ciId, organizationId))) {
        sendCINotFound(res, ciId);
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

      const result = await this.driftDetector.detectDrift(ciId, organizationId);

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

      // drift_detection_results has no organization column: only a CI of the
      // caller's organization is served (a foreign CI is the same 404 as a missing one).
      if (!(await this.neo4jClient.getCI(ciId, requestOrganizationId(req)))) {
        sendCINotFound(res, ciId);
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

      const organizationId = requestOrganizationId(req);
      if (!(await this.neo4jClient.getCI(ci_id, organizationId))) {
        sendCINotFound(res, ci_id);
        return;
      }

      const baseline = await this.driftDetector.createBaseline(
        ci_id,
        snapshot_type,
        this.getActor(req),
        organizationId
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

      // A baseline of another organization's CI reads as missing and is never approved.
      const organizationId = requestOrganizationId(req);
      const existing = await this.driftDetector.getBaselineById(baselineId);
      if (!existing || !(await this.neo4jClient.getCI(existing.ci_id, organizationId))) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Baseline snapshot with ID '${baselineId}' not found`,
        });
        return;
      }

      // Resolved before the approval write, so a lookup failure approves nothing.
      const own = await this.neo4jClient.organizationCIIdsAmong(baselineCIIds(existing), organizationId);
      const approved = await this.driftDetector.approveBaseline(baselineId, this.getActor(req));

      res.json({
        success: true,
        data: baselineInOrganization(approved, own),
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

      const organizationId = requestOrganizationId(req);
      if (!(await this.neo4jClient.getCI(ciId, organizationId))) {
        sendCINotFound(res, ciId);
        return;
      }

      const baseline = await this.driftDetector.getApprovedBaseline(ciId, requestedType);
      const own = await this.neo4jClient.organizationCIIdsAmong(baselineCIIds(baseline), organizationId);

      res.json({
        success: true,
        data: baselineInOrganization(baseline, own),
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

      const organizationId = requestOrganizationId(req);
      if (!(await this.neo4jClient.getCI(ci_id, organizationId))) {
        sendCINotFound(res, ci_id);
        return;
      }

      const impact = await this.impactEngine.predictChangeImpact(ci_id, normalizedChangeType, organizationId);

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

      const organizationId = requestOrganizationId(req);
      if (!(await this.neo4jClient.getCI(rootCiId, organizationId))) {
        sendCINotFound(res, rootCiId);
        return;
      }

      const graph = await this.impactEngine.buildDependencyGraph(rootCiId, maxDepth, organizationId);

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

      const organizationId = requestOrganizationId(req);
      if (!(await this.neo4jClient.getCI(ciId, organizationId))) {
        sendCINotFound(res, ciId);
        return;
      }

      const score = await this.impactEngine.getCriticalityScore(ciId, organizationId);

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

      // impact_analyses has no organization column: only a CI of the caller's
      // organization is served (a foreign CI is the same 404 as a missing one).
      const organizationId = requestOrganizationId(req);
      if (!(await this.neo4jClient.getCI(ciId, organizationId))) {
        sendCINotFound(res, ciId);
        return;
      }

      const history = await this.impactEngine.getImpactHistory(ciId, limitNum);
      const own = await this.neo4jClient.organizationCIIdsAmong(history.flatMap(impactAnalysisCIIds), organizationId);

      res.json({
        success: true,
        data: history.filter(analysis => isImpactAnalysisInOrganization(analysis, own)),
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
