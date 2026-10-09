// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector Configuration CRUD Operations
 * Handles create, read, update, delete operations for connector configurations
 */

import { Request, Response } from 'express';
import { Pool } from 'pg';
import { logger } from '@cmdb/common';
import { validateConfiguration, buildUpdateQuery } from './validation';
import { buildListQuery } from './queries';
import { CONFIG_NOT_FOUND, PUBLIC_CONFIG } from '../../../auth/connector-scope';
import { ownedConfig, requestScopeValues } from './ownership';
import { ConnectorJsonPatchBudget, ConnectorJsonPatchError } from '../../../services/connector-json-merge';

export class ConnectorConfigCRUDController {
  constructor(private pool: Pool) {}

  async listConfigurations(req: Request, res: Response): Promise<void> {
    try {
      const {
        connector_type,
        enabled,
        schedule_enabled,
        search,
        sort_by = 'name',
        sort_order = 'asc',
        limit = 100,
        offset = 0
      } = req.query;
      const [organizationId, legacy] = requestScopeValues(req);

      const { query, params, countQuery, countParams } = buildListQuery({
        connector_type: connector_type as string,
        enabled: enabled as string,
        schedule_enabled: schedule_enabled as string,
        search: search as string,
        sort_by: sort_by as string,
        sort_order: sort_order as string,
        limit: Number(limit),
        offset: Number(offset),
        organizationId,
        legacy,
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
      logger.error('Error listing configurations');
      res.status(500).json({ success: false, error: 'Failed to list configurations' });
    }
  }

  async getConfiguration(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const result = await ownedConfig(this.pool, req, id);

      if (result.rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      res.json({
        success: true,
        data: result.rows[0],
      });
    } catch {
      logger.error('Error getting configuration');
      res.status(500).json({ success: false, error: 'Failed to get configuration' });
    }
  }

  async createConfiguration(req: Request, res: Response): Promise<void> {
    const [organizationId] = requestScopeValues(req);
    if (organizationId === null) {
      res.status(403).json({ error: 'Forbidden', message: 'Organization claim required' });
      return;
    }
    try {
      const validationError = validateConfiguration(req.body);
      if (validationError) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: validationError
        });
        return;
      }

      const {
        name,
        description,
        connector_type,
        enabled,
        schedule,
        schedule_enabled,
        connection,
        options,
        enabled_resources,
        resource_configs,
        max_retries,
        retry_delay_seconds,
        continue_on_error,
        notification_channels,
        notification_on_success,
        notification_on_failure
      } = req.body;
      const budget = new ConnectorJsonPatchBudget();
      const connectionJson = budget.add(connection);
      const optionsJson = budget.add(options ?? {});
      const resourceConfigsJson = budget.add(resource_configs ?? {});

      // Verify connector is installed
      const connectorResult = await this.pool.query(
        'SELECT * FROM installed_connectors WHERE connector_type = $1',
        [connector_type]
      );

      if (connectorResult.rows.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `Connector '${connector_type}' is not installed`
        });
        return;
      }

      // Check for duplicate name
      const existingResult = await this.pool.query(
        'SELECT id FROM connector_configurations WHERE name = $1 AND organization_id = $2',
        [name, organizationId]
      );

      if (existingResult.rows.length > 0) {
        res.status(409).json({
          success: false,
          error: 'Conflict',
          message: `Configuration with name '${name}' already exists`
        });
        return;
      }

      const result = await this.pool.query(
        `INSERT INTO connector_configurations (
          name, description, connector_type, enabled, schedule, schedule_enabled,
          connection, options, enabled_resources, resource_configs,
          max_retries, retry_delay_seconds, continue_on_error,
          notification_channels, notification_on_success, notification_on_failure,
          organization_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW())
        RETURNING ${PUBLIC_CONFIG}`,
        [
          name,
          description || null,
          connector_type,
          enabled !== undefined ? enabled : true,
          schedule || null,
          schedule_enabled !== undefined ? schedule_enabled : false,
          connectionJson,
          optionsJson,
          enabled_resources || null,
          resourceConfigsJson,
          max_retries !== undefined ? max_retries : 3,
          retry_delay_seconds !== undefined ? retry_delay_seconds : 300,
          continue_on_error !== undefined ? continue_on_error : false,
          notification_channels || [],
          notification_on_success !== undefined ? notification_on_success : false,
          notification_on_failure !== undefined ? notification_on_failure : true,
          organizationId
        ]
      );

      logger.info(`Configuration '${name}' created successfully`, {
        id: result.rows[0].id,
        connector_type
      });

      res.status(201).json({
        success: true,
        data: result.rows[0],
        message: `Configuration '${name}' created successfully`
      });
    } catch (error) {
      if (error instanceof ConnectorJsonPatchError) {
        res.status(400).json({ success: false, error: 'Bad Request', message: error.message });
        return;
      }
      logger.error('Error creating configuration');
      res.status(500).json({ success: false, error: 'Failed to create configuration' });
    }
  }

  async updateConfiguration(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Configuration ID is required'
        });
        return;
      }

      const updates = req.body;

      // Check if exists
      const existingResult = await ownedConfig(this.pool, req, id);

      if (existingResult.rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      const { query, values } = buildUpdateQuery(id, updates, requestScopeValues(req));

      if (!query) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'No valid fields to update'
        });
        return;
      }

      const result = await this.pool.query(query as string, values);
      if (result.rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      logger.info(`Configuration '${id}' updated successfully`);

      res.json({
        success: true,
        data: result.rows[0],
        message: 'Configuration updated successfully'
      });
    } catch (error) {
      if (error instanceof ConnectorJsonPatchError) {
        res.status(400).json({ success: false, error: 'Bad Request', message: error.message });
        return;
      }
      logger.error('Error updating configuration');
      res.status(500).json({ success: false, error: 'Failed to update configuration' });
    }
  }

  async deleteConfiguration(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const existingResult = await ownedConfig(this.pool, req, id);

      if (existingResult.rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      const deleted = await this.pool.query(
        'DELETE FROM connector_configurations WHERE id = $1 AND (organization_id = $2 OR (organization_id IS NULL AND $3::boolean)) RETURNING id',
        [id, ...requestScopeValues(req)]
      );
      if (deleted.rows.length === 0) {
        res.status(404).json(CONFIG_NOT_FOUND);
        return;
      }

      logger.info(`Configuration '${id}' deleted successfully`);

      res.json({
        success: true,
        message: 'Configuration deleted successfully'
      });
    } catch {
      logger.error('Error deleting configuration');
      res.status(500).json({ success: false, error: 'Failed to delete configuration' });
    }
  }
}
