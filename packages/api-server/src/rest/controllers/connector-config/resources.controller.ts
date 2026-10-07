// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector Configuration Resources Controller
 * Handles resource management for connector configurations
 */

import { Request, Response } from 'express';
import { Pool } from 'pg';
import { logger } from '@cmdb/common';
import { CONFIG_NOT_FOUND, PUBLIC_CONFIG } from '../../../auth/connector-scope';
import { ownedConfig, requestScopeValues } from './ownership';

export class ConnectorConfigResourcesController {
  constructor(private pool: Pool) {}

  async getAvailableResources(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const result = await this.pool.query(
        `SELECT cc.connector_type, cc.enabled_resources, ic.resources
         FROM connector_configurations cc
         JOIN installed_connectors ic ON cc.connector_type = ic.connector_type
         WHERE cc.id = $1 AND (cc.organization_id = $2 OR (cc.organization_id IS NULL AND $3::boolean))`,
        [id, ...requestScopeValues(req)]
      );

      if (result.rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      const config = result.rows[0];
      const resources = Array.isArray(config.resources)
        ? config.resources.filter((entry: unknown): entry is string => typeof entry === 'string')
        : [];

      res.json({
        success: true,
        data: {
          config_id: id,
          connector_type: config.connector_type,
          available_resources: resources,
          enabled_resources: config.enabled_resources || [],
        },
      });
    } catch {
      logger.error('Error getting available resources');
      res.status(500).json({ success: false, error: 'Failed to get available resources' });
    }
  }

  async updateEnabledResources(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { enabled_resources, resource_configs } = req.body;

      const result = await this.pool.query(
        `UPDATE connector_configurations
         SET enabled_resources = $1, resource_configs = $2, updated_at = NOW()
         WHERE id = $3 AND (organization_id = $4 OR (organization_id IS NULL AND $5::boolean))
         RETURNING ${PUBLIC_CONFIG}`,
        [enabled_resources, JSON.stringify(resource_configs || {}), id, ...requestScopeValues(req)]
      );

      if (result.rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      res.json({
        success: true,
        data: result.rows[0],
        message: 'Enabled resources updated successfully'
      });
    } catch {
      logger.error('Error updating enabled resources');
      res.status(500).json({ success: false, error: 'Failed to update enabled resources' });
    }
  }

  async getResourceConfig(req: Request, res: Response): Promise<void> {
    try {
      const { id, resourceId } = req.params;

      const result = await ownedConfig(this.pool, req, id);

      if (result.rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      // Resource configuration is write-only, including nested connector secrets.

      res.json({
        success: true,
        data: {
          config_id: id,
          resource_id: resourceId
        },
      });
    } catch {
      logger.error('Error getting resource config');
      res.status(500).json({ success: false, error: 'Failed to get resource config' });
    }
  }
}
