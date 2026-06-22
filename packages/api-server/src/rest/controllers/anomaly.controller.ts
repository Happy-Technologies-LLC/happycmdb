// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';
import { getAnomalyDetectionEngine } from '@cmdb/ai-ml-engine';
import type { Anomaly, AnomalyStatus } from '@cmdb/ai-ml-engine';

export class AnomalyController {
  private postgresClient = getPostgresClient();
  private anomalyEngine = getAnomalyDetectionEngine();

  /**
   * Get recent anomalies
   * GET /anomalies/recent
   */
  async getRecentAnomalies(req: Request, res: Response): Promise<void> {
    try {
      const hours = parseInt(String(req.query['hours'] || 24));
      const limit = parseInt(String(req.query['limit'] || 100));

      const anomalies = await this.anomalyEngine.getRecentAnomalies(hours, limit);

      res.json({
        success: true,
        data: anomalies,
      });
    } catch (error) {
      logger.error('Error getting recent anomalies', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve recent anomalies',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get anomalies for a specific CI
   * GET /anomalies/ci/:ciId
   */
  async getAnomaliesForCI(req: Request, res: Response): Promise<void> {
    try {
      const ciId = req.params['ciId'] || '';
      const limit = parseInt(String(req.query['limit'] || 50));

      const anomalies = await this.anomalyEngine.getAnomaliesForCI(ciId, limit);

      res.json({
        success: true,
        data: anomalies,
      });
    } catch (error) {
      logger.error('Error getting anomalies for CI', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve anomalies for CI',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
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

      // Update the anomaly
      const result = await this.postgresClient.query(
        `UPDATE anomalies
         SET status = $1,
             resolved_at = CASE WHEN $1 IN ('resolved', 'false_positive') THEN NOW() ELSE resolved_at END,
             resolved_by = CASE WHEN $1 IN ('resolved', 'false_positive') THEN $2 ELSE resolved_by END
         WHERE id = $3
         RETURNING *`,
        [status, resolved_by, id]
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
  async getAnomalyStats(_req: Request, res: Response): Promise<void> {
    try {
      // Get total count
      const totalResult = await this.postgresClient.query(
        'SELECT COUNT(*) as total FROM anomalies'
      );

      // Get counts by severity
      const severityResult = await this.postgresClient.query(`
        SELECT severity, COUNT(*) as count
        FROM anomalies
        GROUP BY severity
      `);

      // Get counts by type
      const typeResult = await this.postgresClient.query(`
        SELECT anomaly_type, COUNT(*) as count
        FROM anomalies
        GROUP BY anomaly_type
        ORDER BY count DESC
      `);

      // Get counts by status
      const statusResult = await this.postgresClient.query(`
        SELECT status, COUNT(*) as count
        FROM anomalies
        GROUP BY status
      `);

      const bySeverity: Record<string, number> = {};
      severityResult.rows.forEach((row: any) => {
        bySeverity[row.severity] = parseInt(row.count);
      });

      const byType: Record<string, number> = {};
      typeResult.rows.forEach((row: any) => {
        byType[row.anomaly_type] = parseInt(row.count);
      });

      const byStatus: Record<string, number> = {};
      statusResult.rows.forEach((row: any) => {
        byStatus[row.status] = parseInt(row.count);
      });

      res.json({
        success: true,
        data: {
          total: parseInt(totalResult.rows[0].total),
          by_severity: bySeverity,
          by_type: byType,
          by_status: byStatus,
        },
      });
    } catch (error) {
      logger.error('Error getting anomaly stats', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve anomaly statistics',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Run anomaly detection manually
   * POST /anomalies/detect
   */
  async runAnomalyDetection(_req: Request, res: Response): Promise<void> {
    try {
      logger.info('Manual anomaly detection triggered via API');
      const anomalies = await this.anomalyEngine.detectAnomalies();

      res.json({
        success: true,
        data: {
          detected_count: anomalies.length,
          anomalies: anomalies,
        },
      });
    } catch (error) {
      logger.error('Error running anomaly detection', error);
      res.status(500).json({
        success: false,
        error: 'Failed to run anomaly detection',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
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
