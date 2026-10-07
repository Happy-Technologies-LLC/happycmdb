// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector Configuration Operations Controller
 * Handles operational actions: enable, disable, test, run
 */

import { Request, Response } from 'express';
import { Pool } from 'pg';
import { logger } from '@cmdb/common';
import { getIntegrationManager } from '@cmdb/integration-framework/dist/core/integration-manager';
import { CONFIG_NOT_FOUND, PUBLIC_CONFIG, PUBLIC_RUN } from '../../../auth/connector-scope';
import { ownedConfig, requestScopeValues } from './ownership';

export class ConnectorConfigOperationsController {
  constructor(private pool: Pool) {}

  async enableConfiguration(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const result = await this.pool.query(
        `UPDATE connector_configurations SET enabled = true, updated_at = NOW()
         WHERE id = $1 AND (organization_id = $2 OR (organization_id IS NULL AND $3::boolean))
         RETURNING ${PUBLIC_CONFIG}`,
        [id, ...requestScopeValues(req)]
      );

      if (result.rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      res.json({
        success: true,
        data: result.rows[0],
        message: 'Configuration enabled successfully'
      });
    } catch {
      logger.error('Error enabling configuration');
      res.status(500).json({ success: false, error: 'Failed to enable configuration' });
    }
  }

  async disableConfiguration(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const result = await this.pool.query(
        `UPDATE connector_configurations SET enabled = false, updated_at = NOW()
         WHERE id = $1 AND (organization_id = $2 OR (organization_id IS NULL AND $3::boolean))
         RETURNING ${PUBLIC_CONFIG}`,
        [id, ...requestScopeValues(req)]
      );

      if (result.rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      res.json({
        success: true,
        data: result.rows[0],
        message: 'Configuration disabled successfully'
      });
    } catch {
      logger.error('Error disabling configuration');
      res.status(500).json({ success: false, error: 'Failed to disable configuration' });
    }
  }

  async testConnection(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const result = await ownedConfig(this.pool, req, id);

      if (result.rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      const testResult = await getIntegrationManager().testConnector(id, result.rows[0].organization_id);
      res.json({ success: testResult.success === true });
    } catch (error) {
      if (error instanceof Error && error.message === 'CONNECTOR_NOT_FOUND') {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }
      if (error instanceof Error && error.message === 'CONNECTOR_CREDENTIAL_UNAVAILABLE') {
        res.status(409).json({ success: false, error: 'Connector credential reference unavailable' });
        return;
      }
      logger.error('Error testing connection');
      res.status(500).json({ success: false, error: 'Failed to test connection' });
    }
  }

  async runConnector(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { resource_id } = req.body;

      const result = await ownedConfig(this.pool, req, id, true);

      if (result.rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      const config = result.rows[0];
      if (config.credential_id) {
        res.status(409).json({ success: false, error: 'Connector credential reference unavailable' });
        return;
      }

      if (!config.enabled) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Configuration is disabled'
        });
        return;
      }

      // TODO: Actual run logic (create BullMQ job)
      const runResult = await this.pool.query(
        `INSERT INTO connector_run_history (
          config_id, connector_type, config_name, resource_id,
          organization_id, started_at, status, triggered_by
        )
        SELECT id, connector_type, name, $4, organization_id, NOW(), 'queued', 'manual'
        FROM connector_configurations
        WHERE id = $1 AND enabled = true AND credential_id IS NULL
          AND (organization_id = $2 OR (organization_id IS NULL AND $3::boolean))
        RETURNING ${PUBLIC_RUN}`,
        [id, ...requestScopeValues(req), resource_id || null]
      );
      if (runResult.rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      logger.info('Connector run queued', {
        config_id: id,
        run_id: runResult.rows[0].id,
      });

      res.status(202).json({
        success: true,
        data: runResult.rows[0],
        message: 'Connector run queued successfully'
      });
    } catch {
      logger.error('Error running connector');
      res.status(500).json({ success: false, error: 'Failed to run connector' });
    }
  }
}
