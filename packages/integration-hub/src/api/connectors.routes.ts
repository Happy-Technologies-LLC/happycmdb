// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration Hub - Connectors API Routes
 */

import { Router } from 'express';
import { getIntegrationManager } from '@cmdb/integration-framework';
import { getConnectorRegistry } from '@cmdb/integration-framework';
import { getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';

export const connectorsRouter = Router();
const integrationManager = getIntegrationManager();
const connectorRegistry = getConnectorRegistry();
const postgresClient = getPostgresClient();

/**
 * List all connector types (from marketplace)
 */
connectorsRouter.get('/types', async (_req, res) => {
  try {
    const types = connectorRegistry.getAllConnectorTypes();
    res.json({ types });
  } catch (error) {
    logger.error('Failed to list connector types', { error });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Get connector type metadata
 */
connectorsRouter.get('/types/:type', async (req, res) => {
  try {
    const metadata = connectorRegistry.getConnectorMetadata(req.params.type);
    if (!metadata) {
      res.status(404).json({ error: 'Connector type not found' });
      return;
    }
    res.json({ metadata });
  } catch (error) {
    logger.error('Failed to get connector type', { error });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * List all connector instances
 */
connectorsRouter.get('/', async (_req, res) => {
  try {
    const result = await postgresClient.query(
      `SELECT
        id, name, connector_type, enabled, schedule,
        created_at, updated_at,
        (SELECT status FROM connector_run_history
         WHERE config_name = connector_configurations.name
         ORDER BY started_at DESC LIMIT 1) as status,
        (SELECT started_at FROM connector_run_history
         WHERE config_name = connector_configurations.name
         ORDER BY started_at DESC LIMIT 1) as last_run,
        (SELECT COUNT(*) FROM connector_run_history
         WHERE config_name = connector_configurations.name) as total_runs,
        (SELECT COUNT(*) FROM connector_run_history
         WHERE config_name = connector_configurations.name
         AND status = 'completed') as successful_runs
       FROM connector_configurations
       ORDER BY name`
    );

    const connectors = result.rows.map(row => ({
      ...row,
      metrics: {
        total_runs: parseInt(row.total_runs),
        success_rate: row.total_runs > 0
          ? (row.successful_runs / row.total_runs) * 100
          : 0,
      }
    }));

    res.json({ connectors });
  } catch (error) {
    logger.error('Failed to list connectors', { error });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Get connector instance by name
 */
connectorsRouter.get('/:name', async (req, res) => {
  try {
    const result = await postgresClient.query(
      'SELECT * FROM connector_configurations WHERE name = $1',
      [req.params.name]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Connector not found' });
      return;
    }

    res.json({ connector: result.rows[0] });
  } catch (error) {
    logger.error('Failed to get connector', { error });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Create new connector instance
 */
connectorsRouter.post('/', async (req, res) => {
  try {
    const { name, type, enabled = true, schedule, connection, options } = req.body;

    // Validate connector type exists
    if (!connectorRegistry.hasConnectorType(type)) {
      res.status(400).json({ error: `Unknown connector type: ${type}` });
      return;
    }

    // Insert into database
    const result = await postgresClient.query(
      `INSERT INTO connector_configurations
       (name, connector_type, enabled, schedule, connection, options)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [name, type, enabled, schedule, JSON.stringify(connection), JSON.stringify(options || {})]
    );

    const connector = result.rows[0];

    // Register with integration manager
    await integrationManager.registerConnector({
      id: connector.id,
      name: connector.name,
      type: connector.connector_type,
      enabled: connector.enabled,
      schedule: connector.schedule,
      connection: connector.connection,
      options: connector.options,
    });

    res.status(201).json({ connector });
  } catch (error) {
    logger.error('Failed to create connector', { error });
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * Update connector instance
 */
connectorsRouter.put('/:name', async (req, res) => {
  try {
    const { enabled, schedule, connection, options } = req.body;

    const result = await postgresClient.query(
      `UPDATE connector_configurations
       SET enabled = COALESCE($2, enabled),
           schedule = COALESCE($3, schedule),
           connection = COALESCE($4, connection),
           options = COALESCE($5, options),
           updated_at = NOW()
       WHERE name = $1
       RETURNING *`,
      [
        req.params.name,
        enabled,
        schedule,
        connection ? JSON.stringify(connection) : null,
        options ? JSON.stringify(options) : null,
      ]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Connector not found' });
      return;
    }

    res.json({ connector: result.rows[0] });
  } catch (error) {
    logger.error('Failed to update connector', { error });
    res.status(400).json({ error: (error as Error).message });
  }
});

/**
 * Delete connector instance
 */
connectorsRouter.delete('/:name', async (req, res) => {
  try {
    await integrationManager.unregisterConnector(req.params.name);

    await postgresClient.query(
      'DELETE FROM connector_configurations WHERE name = $1',
      [req.params.name]
    );

    res.status(204).send();
  } catch (error) {
    logger.error('Failed to delete connector', { error });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Test connector connection
 */
connectorsRouter.post('/:name/test', async (req, res) => {
  try {
    const result = await integrationManager.testConnector(req.params.name);
    res.json({ result });
  } catch (error) {
    logger.error('Failed to test connector', { error });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Run connector manually
 */
connectorsRouter.post('/:name/run', async (req, res) => {
  try {
    const runResult = await integrationManager.runConnector(req.params.name);
    res.json({ result: runResult });
  } catch (error) {
    logger.error('Failed to run connector', { error });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Get connector run history
 */
connectorsRouter.get('/:name/runs', async (req, res) => {
  try {
    const limit = parseInt(req.query['limit'] as string) || 50;
    const offset = parseInt(req.query['offset'] as string) || 0;

    const result = await postgresClient.query(
      `SELECT * FROM connector_run_history
       WHERE config_name = $1
       ORDER BY started_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.name, limit, offset]
    );

    res.json({ runs: result.rows });
  } catch (error) {
    logger.error('Failed to get connector runs', { error });
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * Get connector run logs
 */
connectorsRouter.get('/:name/runs/:runId/logs', async (req, res) => {
  try {
    const runResult = await postgresClient.query(
      'SELECT id FROM connector_run_history WHERE id = $1 AND config_name = $2',
      [req.params.runId, req.params.name]
    );

    if (runResult.rows.length === 0) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    const logsResult = await postgresClient.query(
      `SELECT id, "timestamp", level, message
       FROM connector_run_log_entries
       WHERE run_id = $1
       ORDER BY "timestamp" ASC, sequence ASC`,
      [req.params.runId]
    );

    res.json({ logs: logsResult.rows });
  } catch (error) {
    logger.error('Failed to get connector run logs', { error });
    res.status(500).json({ error: (error as Error).message });
  }
});
