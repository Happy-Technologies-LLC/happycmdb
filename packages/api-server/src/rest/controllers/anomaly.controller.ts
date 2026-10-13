// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { getPostgresClient, getNeo4jClient } from '@cmdb/database';
import { logger, ciIncarnationId } from '@cmdb/common';
import { requestOrganizationId } from '../../middleware/auth.middleware';
import type { Anomaly, AnomalyStatus } from '@cmdb/ai-ml-engine';

export class AnomalyController {
  private postgresClient = getPostgresClient();
  private neo4jClient = getNeo4jClient();

  /**
   * Get recent anomalies
   * GET /anomalies/recent
   */
  async getRecentAnomalies(req: Request, res: Response): Promise<void> {
    try {
      const organizationId = requestOrganizationId(req);
      const current = await this.currentIncarnations(organizationId);
      const result = await this.postgresClient.query(
        `SELECT a.* FROM anomalies a
         JOIN jsonb_to_recordset($2::jsonb) AS ci("ciId" text, "incarnationId" uuid)
           ON ci."ciId" = a.ci_id AND ci."incarnationId" = a.ci_incarnation_id
         WHERE a.organization_id = $1 AND a.detected_at >= NOW() - ($3 * INTERVAL '1 hour')
           AND a.status IN ('detected', 'investigating')
         ORDER BY a.detected_at DESC LIMIT $4`,
        [organizationId, JSON.stringify(current), Number(req.query['hours'] ?? 24), Number(req.query['limit'] ?? 100)]
      );
      res.json({ success: true, data: result.rows.map(row => this.mapRowToAnomaly(row)) });
    } catch (error) {
      logger.error('Error getting recent anomalies', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve recent anomalies' });
    }
  }

  /**
   * Get anomalies for a specific CI
   * GET /anomalies/ci/:ciId
   */
  async getAnomaliesForCI(req: Request, res: Response): Promise<void> {
    try {
      const ciId = req.params['ciId'] || '';
      const organizationId = requestOrganizationId(req);
      const ci = await this.neo4jClient.getCI(ciId, organizationId);
      const incarnationId = ciIncarnationId(ci);
      if (!incarnationId) {
        res.status(404).json({ success: false, error: 'Not Found', message: 'CI not found' });
        return;
      }
      const result = await this.postgresClient.query(
        `SELECT * FROM anomalies WHERE ci_id = $1 AND organization_id = $2
           AND ci_incarnation_id = $3::uuid ORDER BY detected_at DESC LIMIT $4`,
        [ciId, organizationId, incarnationId, Number(req.query['limit'] ?? 50)]
      );
      res.json({ success: true, data: result.rows.map(row => this.mapRowToAnomaly(row)) });
    } catch (error) {
      logger.error('Error getting anomalies for CI', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve anomalies for CI' });
    }
  }

  /**
   * Update anomaly status
   * PATCH /anomalies/:id/status
   */
  async updateAnomalyStatus(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { status, resolved_by } = req.body;

      // Validate status
      const validStatuses: AnomalyStatus[] = [
        'investigating' as AnomalyStatus,
        'resolved' as AnomalyStatus,
        'false_positive' as AnomalyStatus,
        'confirmed' as AnomalyStatus,
        'ignored' as AnomalyStatus,
      ];

      if (!validStatuses.includes(status)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
        });
        return;
      }

      // The graph establishes current ownership; the SQL mutation enforces the
      // same owner and incarnation in its WHERE clause, not a prior row lookup.
      const organizationId = requestOrganizationId(req);
      const result = await this.postgresClient.query(
        `UPDATE anomalies a
         SET status = $1,
             resolved_at = CASE WHEN $1 IN ('resolved', 'false_positive') THEN NOW() ELSE a.resolved_at END,
             resolved_by = CASE WHEN $1 IN ('resolved', 'false_positive') THEN $2 ELSE a.resolved_by END
         WHERE a.id = $3 AND a.organization_id = $4
           AND EXISTS (
             SELECT 1 FROM jsonb_to_recordset($5::jsonb) AS ci("ciId" text, "incarnationId" uuid)
             WHERE ci."ciId" = a.ci_id AND ci."incarnationId" = a.ci_incarnation_id
           )
         RETURNING a.*`,
        [status, resolved_by, id, organizationId, JSON.stringify(await this.currentIncarnations(organizationId))]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Anomaly not found',
        });
        return;
      }

      res.json({
        success: true,
        data: this.mapRowToAnomaly(result.rows[0]),
      });
    } catch (error) {
      logger.error('Error updating anomaly status', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update anomaly status',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get anomaly statistics
   * GET /anomalies/stats
   */
  async getAnomalyStats(req: Request, res: Response): Promise<void> {
    try {
      const organizationId = requestOrganizationId(req);
      const current = await this.currentIncarnations(organizationId);
      const result = await this.postgresClient.query(
        `WITH owned AS (
           SELECT a.severity, a.anomaly_type, a.status FROM anomalies a
           JOIN jsonb_to_recordset($2::jsonb) AS ci("ciId" text, "incarnationId" uuid)
             ON ci."ciId" = a.ci_id AND ci."incarnationId" = a.ci_incarnation_id
           WHERE a.organization_id = $1
         )
         SELECT severity, anomaly_type, status, COUNT(*) AS count,
           GROUPING(severity, anomaly_type, status) AS grouping_key
         FROM owned GROUP BY GROUPING SETS ((), (severity), (anomaly_type), (status))`,
        [organizationId, JSON.stringify(current)]
      );
      const data = {
        total: 0,
        by_severity: {} as Record<string, number>,
        by_type: {} as Record<string, number>,
        by_status: {} as Record<string, number>,
      };
      for (const row of result.rows) {
        const count = Number(row.count);
        switch (row.grouping_key) {
          case 7: data.total = count; break;
          case 3: data.by_severity[row.severity] = count; break;
          case 5: data.by_type[row.anomaly_type] = count; break;
          case 6: data.by_status[row.status] = count; break;
        }
      }
      res.json({ success: true, data });
    } catch (error) {
      logger.error('Error getting anomaly stats', error);
      res.status(500).json({ success: false, error: 'Failed to retrieve anomaly statistics' });
    }
  }

  /**
   * Run anomaly detection manually
   * POST /anomalies/detect
   */
  async runAnomalyDetection(_req: Request, res: Response): Promise<void> {
    // The scheduled producer scans across organizations and does not stamp
    // trustworthy owner/incarnation provenance. It cannot be exposed to tenants.
    res.status(403).json({ success: false, error: 'Forbidden' });
  }

  private async currentIncarnations(organizationId: string): Promise<Array<{ ciId: string; incarnationId: string }>> {
    const current: Array<{ ciId: string; incarnationId: string }> = [];
    for (const ci of await this.neo4jClient.listCIIncarnations(organizationId)) {
      if (ci.organizationId === organizationId) current.push({ ciId: ci.ciId, incarnationId: ci.incarnationId });
    }
    return current;
  }

  /**
   * Map database row to Anomaly object
   */
  private mapRowToAnomaly(row: any): Anomaly {
    return {
      id: row.id,
      ci_id: row.ci_id,
      ci_name: row.ci_name,
      anomaly_type: row.anomaly_type,
      severity: row.severity,
      confidence_score: row.confidence_score,
      detected_at: row.detected_at,
      description: row.description,
      metrics: row.metrics,
      context: row.context,
      status: row.status,
      resolved_at: row.resolved_at,
      resolved_by: row.resolved_by,
    };
  }
}
