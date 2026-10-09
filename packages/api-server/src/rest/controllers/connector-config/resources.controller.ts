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
import { ConnectorJsonPatchBudget, ConnectorJsonPatchError, connectorJsonMerge } from '../../../services/connector-json-merge';

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
      const resources: unknown[] = [];
      if (Array.isArray(config.resources)) {
        for (const entry of config.resources) {
          if (typeof entry === 'string') {
            resources.push(entry);
            continue;
          }
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
          const descriptor = entry as Record<string, unknown>;
          if (typeof descriptor['id'] !== 'string' || typeof descriptor['name'] !== 'string') continue;
          resources.push({
            id: descriptor['id'],
            name: descriptor['name'],
            description: typeof descriptor['description'] === 'string' ? descriptor['description'] : '',
            ci_type: typeof descriptor['ci_type'] === 'string' ? descriptor['ci_type'] : null,
            operations: Array.isArray(descriptor['operations'])
              ? descriptor['operations'].filter((operation: unknown) =>
                ['extract', 'transform', 'load', 'sync_to_source', 'test_connection'].includes(operation as string))
              : [],
            enabled_by_default: descriptor['enabled_by_default'] === true,
          });
        }
      }

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

      const values: unknown[] = [enabled_resources];
      const configs = resource_configs === undefined
        ? 'resource_configs'
        : connectorJsonMerge('resource_configs', resource_configs, values, new ConnectorJsonPatchBudget());
      const idParam = values.length + 1;
      const result = await this.pool.query(
        `UPDATE connector_configurations
         SET enabled_resources = $1,
             resource_configs = ${configs}, updated_at = NOW()
         WHERE id = $${idParam} AND (organization_id = $${idParam + 1}
           OR (organization_id IS NULL AND $${idParam + 2}::boolean))
         RETURNING ${PUBLIC_CONFIG}`,
        [...values, id, ...requestScopeValues(req)]
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
    } catch (error) {
      if (error instanceof ConnectorJsonPatchError) {
        res.status(400).json({ success: false, error: 'Bad Request', message: error.message });
        return;
      }
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
