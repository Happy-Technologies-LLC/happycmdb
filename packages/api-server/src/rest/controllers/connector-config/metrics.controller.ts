// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector Configuration Metrics Controller
 * Handles metrics and run history for connector configurations
 */

import { Request, Response } from 'express';
import { Pool } from 'pg';
import { logger } from '@cmdb/common';
import { buildRunsQuery } from './queries';
import { CONFIG_NOT_FOUND, RUN_NOT_FOUND } from '../../../auth/connector-scope';
import { ownedConfig, ownedRun, requestScopeValues } from './ownership';

export class ConnectorConfigMetricsController {
  constructor(private pool: Pool) {}

  async getConfigurationMetrics(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      if ((await ownedConfig(this.pool, req, id)).rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      const statsResult = await this.pool.query(
        `SELECT
          COUNT(*) as total_runs,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as successful_runs,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_runs,
          AVG(duration_ms) as avg_duration_ms,
          SUM(records_extracted) as total_records_extracted,
          SUM(records_loaded) as total_records_loaded
         FROM connector_run_history
         WHERE config_id = $1 AND (organization_id = $2 OR (organization_id IS NULL AND $3::boolean))`,
        [id, ...requestScopeValues(req)]
      );

      const stats = statsResult.rows[0];
      const successRate = stats.total_runs > 0
        ? (parseFloat(stats.successful_runs) / parseFloat(stats.total_runs)) * 100
        : 0;

      res.json({
        success: true,
        data: {
          config_id: id,
          total_runs: parseInt(stats.total_runs),
          successful_runs: parseInt(stats.successful_runs),
          failed_runs: parseInt(stats.failed_runs),
          success_rate: Math.round(successRate * 100) / 100,
          avg_duration_ms: stats.avg_duration_ms ? Math.round(parseFloat(stats.avg_duration_ms)) : 0,
          total_records_extracted: parseInt(stats.total_records_extracted || 0),
          total_records_loaded: parseInt(stats.total_records_loaded || 0),
        },
      });
    } catch {
      logger.error('Error getting configuration metrics');
      res.status(500).json({ success: false, error: 'Failed to get configuration metrics' });
    }
  }

  async getResourceMetrics(req: Request, res: Response): Promise<void> {
    try {
      const { id, resourceId } = req.params;
      if ((await ownedConfig(this.pool, req, id)).rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      const result = await this.pool.query(
        `SELECT rm.id, rm.config_id, rm.connector_type, rm.resource_id, rm.measured_at,
                rm.avg_extraction_time_ms, rm.avg_transformation_time_ms, rm.avg_load_time_ms,
                rm.total_records_extracted, rm.total_records_loaded, rm.total_records_failed, rm.success_rate
         FROM connector_resource_metrics rm JOIN connector_configurations cc ON cc.id = rm.config_id
         WHERE rm.config_id = $1 AND rm.resource_id = $2
           AND (cc.organization_id = $3 OR (cc.organization_id IS NULL AND $4::boolean))
         ORDER BY rm.measured_at DESC LIMIT 1`,
        [id, resourceId, ...requestScopeValues(req)]
      );

      res.json({
        success: true,
        data: result.rows[0] || null,
      });
    } catch {
      logger.error('Error getting resource metrics');
      res.status(500).json({ success: false, error: 'Failed to get resource metrics' });
    }
  }

  async getConfigurationRuns(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const {
        resource_id,
        status,
        limit = 100,
        offset = 0,
        sort_by = 'started_at',
        sort_order = 'desc'
      } = req.query;
      if ((await ownedConfig(this.pool, req, id)).rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      const { query, params, countQuery, countParams } = buildRunsQuery({
        config_id: id,
        resource_id: resource_id as string,
        status: status as string,
        limit: Number(limit),
        offset: Number(offset),
        sort_by: sort_by as string,
        sort_order: sort_order as string,
        organizationId: requestScopeValues(req)[0],
        legacy: requestScopeValues(req)[1],
      });

      const countResult = await this.pool.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0].count);

      const result = await this.pool.query(query, params);

      res.json({
        success: true,
        data: result.rows,
        pagination: {
          total,
          count: result.rows.length,
          limit: Number(limit),
          offset: Number(offset),
        },
      });
    } catch {
      logger.error('Error getting configuration runs');
      res.status(500).json({ success: false, error: 'Failed to get configuration runs' });
    }
  }

  async getAllRuns(req: Request, res: Response): Promise<void> {
    try {
      const {
        config_id,
        connector_type,
        resource_id,
        status,
        limit = 100,
        offset = 0,
        sort_by = 'started_at',
        sort_order = 'desc'
      } = req.query;
      if (config_id && (await ownedConfig(this.pool, req, config_id as string)).rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      const { query, params, countQuery, countParams } = buildRunsQuery({
        config_id: config_id as string,
        connector_type: connector_type as string,
        resource_id: resource_id as string,
        status: status as string,
        limit: Number(limit),
        offset: Number(offset),
        sort_by: sort_by as string,
        sort_order: sort_order as string,
        organizationId: requestScopeValues(req, false)[0],
        legacy: requestScopeValues(req, false)[1],
      });

      const countResult = await this.pool.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0].count);

      const result = await this.pool.query(query, params);

      res.json({
        success: true,
        data: result.rows,
        pagination: {
          total,
          count: result.rows.length,
          limit: Number(limit),
          offset: Number(offset),
        },
      });
    } catch {
      logger.error('Error getting all runs');
      res.status(500).json({ success: false, error: 'Failed to get runs' });
    }
  }

  async getRunDetails(req: Request, res: Response): Promise<void> {
    try {
      const { runId } = req.params;

      const result = await ownedRun(this.pool, req, runId);

      if (result.rows.length === 0) {
        res.status(404).json(RUN_NOT_FOUND);
        return;
      }

      res.json({
        success: true,
        data: result.rows[0],
      });
    } catch {
      logger.error('Error getting run details');
      res.status(500).json({ success: false, error: 'Failed to get run details' });
    }
  }

  async cancelRun(req: Request, res: Response): Promise<void> {
    try {
      const { runId } = req.params;

      const runResult = await ownedRun(this.pool, req, runId);

      if (runResult.rows.length === 0) {
        res.status(404).json(RUN_NOT_FOUND);
        return;
      }

      const run = runResult.rows[0];
      if (!['queued', 'running'].includes(run.status)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `Run is in '${run.status}' status and cannot be cancelled`
        });
        return;
      }

      // TODO: Cancel BullMQ job
      const cancelled = await this.pool.query(
        `UPDATE connector_run_history SET status = $1, completed_at = NOW()
         WHERE id = $2 AND status IN ('queued', 'running')
         AND (organization_id = $3 OR (organization_id IS NULL AND $4::boolean))
         RETURNING id`,
        ['cancelled', runId, ...requestScopeValues(req)]
      );
      if (cancelled.rows.length === 0) {
        res.status(404).json(RUN_NOT_FOUND);
        return;
      }

      logger.info(`Run '${runId}' cancelled successfully`);

      res.json({
        success: true,
        message: 'Run cancelled successfully'
      });
    } catch {
      logger.error('Error cancelling run');
      res.status(500).json({ success: false, error: 'Failed to cancel run' });
    }
  }
}
