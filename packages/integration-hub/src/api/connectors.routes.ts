// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Router, Request, Response } from 'express';
import { getIntegrationManager, getConnectorRegistry } from '@cmdb/integration-framework';
import { getPostgresClient } from '@cmdb/database';
import {
  connectorScope, connectorPredicate, scopeValues, PUBLIC_CONFIG, PUBLIC_RUN,
  CONFIG_NOT_FOUND, RUN_NOT_FOUND,
} from '@cmdb/api-server/auth/connector-scope';
import type { TokenPayload } from '@cmdb/api-server/auth/types';

export const connectorsRouter = Router();
const integrationManager = getIntegrationManager();
const connectorRegistry = getConnectorRegistry();
const postgresClient = getPostgresClient();

type AuthenticatedRequest = Request & { user?: TokenPayload };
const scope = (req: Request) => connectorScope((req as AuthenticatedRequest).user);
const values = (req: Request) => scopeValues((req as AuthenticatedRequest).user);
const configColumns = PUBLIC_CONFIG.split(',').map((column: string) => `c.${column.trim()}`).join(', ');
const runColumns = PUBLIC_RUN.split(',').map((column: string) => `r.${column.trim()}`).join(', ');
const failed = (res: Response) => res.status(500).json({ error: 'Connector operation failed' });

async function ownedConfig(req: Request) {
  const result = await postgresClient.query(
    `SELECT c.id, c.organization_id FROM connector_configurations c
     WHERE c.name = $1 AND ${connectorPredicate('c', 2)}`,
    [req.params['name'], ...values(req)]
  );
  return result.rows[0] as { id: string; organization_id: string | null } | undefined;
}
async function registerCurrentConfig(configId: string, organizationId: string): Promise<void> {
  const current = await postgresClient.query(
    `SELECT c.id, c.organization_id, c.name, c.connector_type, c.credential_id, c.enabled,
      c.schedule, c.connection, c.options, c.created_at, c.updated_at
     FROM connector_configurations c WHERE c.id = $1 AND c.organization_id = $2`,
    [configId, organizationId]
  );
  if (current.rows.length) {
    await integrationManager.registerConnector(integrationManager.mapRowToConfig(current.rows[0]));
  }
}


connectorsRouter.get('/types', (_req, res) => {
  res.json({ types: connectorRegistry.getAllConnectorTypes() });
});
connectorsRouter.get('/types/:type', (req, res) => {
  const metadata = connectorRegistry.getConnectorMetadata(req.params.type);
  if (!metadata) return res.status(404).json({ error: 'Connector type not found' });
  return res.json({ metadata });
});

connectorsRouter.get('/', async (req, res) => {
  try {
    const result = await postgresClient.query(
      `SELECT ${configColumns},
        (SELECT r.status FROM connector_run_history r WHERE r.config_id = c.id AND r.organization_id IS NOT DISTINCT FROM c.organization_id ORDER BY r.started_at DESC LIMIT 1) AS status,
        (SELECT r.started_at FROM connector_run_history r WHERE r.config_id = c.id AND r.organization_id IS NOT DISTINCT FROM c.organization_id ORDER BY r.started_at DESC LIMIT 1) AS last_run,
        (SELECT COUNT(*) FROM connector_run_history r WHERE r.config_id = c.id AND r.organization_id IS NOT DISTINCT FROM c.organization_id) AS total_runs,
        (SELECT COUNT(*) FROM connector_run_history r WHERE r.config_id = c.id AND r.organization_id IS NOT DISTINCT FROM c.organization_id AND r.status = 'completed') AS successful_runs
       FROM connector_configurations c WHERE ${connectorPredicate('c', 1)} ORDER BY c.name`, values(req)
    );
    res.json({ connectors: result.rows.map(row => ({
      ...row,
      metrics: {
        total_runs: Number(row.total_runs),
        success_rate: Number(row.total_runs) ? Number(row.successful_runs) / Number(row.total_runs) * 100 : 0,
      },
    })) });
  } catch { failed(res); }
});

connectorsRouter.get('/:name', async (req, res) => {
  try {
    const result = await postgresClient.query(
      `SELECT ${configColumns} FROM connector_configurations c WHERE c.name = $1 AND ${connectorPredicate('c', 2)}`,
      [req.params.name, ...values(req)]
    );
    if (!result.rows.length) return res.status(404).json(CONFIG_NOT_FOUND);
    return res.json({ connector: result.rows[0] });
  } catch { return failed(res); }
});

connectorsRouter.post('/', async (req, res) => {
  try {
    const { name, type, enabled = true, schedule, connection, options } = req.body;
    if (!connectorRegistry.hasConnectorType(type)) return res.status(400).json({ error: 'Unknown connector type' });
    const organizationId = scope(req).organizationId;
    if (!organizationId) return res.status(403).json({ error: 'Organization required for creation' });
    const result = await postgresClient.query(
      `INSERT INTO connector_configurations (organization_id, name, connector_type, enabled, schedule, connection, options)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${PUBLIC_CONFIG}`,
      [organizationId, name, type, enabled, schedule, JSON.stringify(connection ?? {}), JSON.stringify(options ?? {})]
    );
    await registerCurrentConfig(result.rows[0].id, organizationId);
    return res.status(201).json({ connector: result.rows[0] });
  } catch { return failed(res); }
});

connectorsRouter.put('/:name', async (req, res) => {
  try {
    const { enabled, schedule, connection, options } = req.body;
    const result = await postgresClient.query(
      `UPDATE connector_configurations c SET enabled = COALESCE($4, c.enabled),
        schedule = COALESCE($5, c.schedule), connection = COALESCE($6, c.connection),
        options = COALESCE($7, c.options), updated_at = NOW()
       WHERE c.name = $1 AND ${connectorPredicate('c', 2)} RETURNING ${configColumns}`,
      [req.params.name, ...values(req), enabled, schedule,
        connection === undefined ? null : JSON.stringify(connection),
        options === undefined ? null : JSON.stringify(options)]
    );
    if (!result.rows.length) return res.status(404).json(CONFIG_NOT_FOUND);
    await integrationManager.unregisterConnector(result.rows[0].id);
    if (result.rows[0].organization_id) {
      await registerCurrentConfig(result.rows[0].id, result.rows[0].organization_id);
    }
    return res.json({ connector: result.rows[0] });
  } catch { return failed(res); }
});

connectorsRouter.delete('/:name', async (req, res) => {
  try {
    const result = await postgresClient.query(
      `DELETE FROM connector_configurations c WHERE c.name = $1 AND ${connectorPredicate('c', 2)} RETURNING c.id`,
      [req.params.name, ...values(req)]
    );
    if (!result.rows.length) return res.status(404).json(CONFIG_NOT_FOUND);
    await integrationManager.unregisterConnector(result.rows[0].id);
    return res.status(204).send();
  } catch { return failed(res); }
});

connectorsRouter.post('/:name/test', async (req, res) => {
  try {
    const config = await ownedConfig(req);
    if (!config) return res.status(404).json(CONFIG_NOT_FOUND);
    const result = await integrationManager.testConnector(config.id, config.organization_id);
    return res.json({ result: { success: result.success === true } });
  } catch (error) {
    if (error instanceof Error && error.message === 'CONNECTOR_NOT_FOUND') return res.status(404).json(CONFIG_NOT_FOUND);
    return failed(res);
  }
});

connectorsRouter.post('/:name/run', async (req, res) => {
  try {
    const config = await ownedConfig(req);
    if (!config) return res.status(404).json(CONFIG_NOT_FOUND);
    const result = await integrationManager.runConnector(config.id, config.organization_id);
    const run = await postgresClient.query(
      `SELECT ${runColumns} FROM connector_run_history r
       WHERE r.config_id = $1 AND r.job_id = $2 AND ${connectorPredicate('r', 3)}`,
      [config.id, result.run_id, ...values(req)]
    );
    if (!run.rows.length) return res.status(404).json(RUN_NOT_FOUND);
    return res.json({ result: run.rows[0] });
  } catch (error) {
    if (error instanceof Error && error.message === 'CONNECTOR_NOT_FOUND') return res.status(404).json(CONFIG_NOT_FOUND);
    return failed(res);
  }
});

connectorsRouter.get('/:name/runs', async (req, res) => {
  try {
    const config = await ownedConfig(req);
    if (!config) return res.status(404).json(CONFIG_NOT_FOUND);
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query['limit'] ?? '50'), 10) || 50));
    const offset = Math.max(0, Number.parseInt(String(req.query['offset'] ?? '0'), 10) || 0);
    const result = await postgresClient.query(
      `SELECT ${runColumns} FROM connector_run_history r
       WHERE r.config_id = $1 AND ${connectorPredicate('r', 2)}
       ORDER BY r.started_at DESC LIMIT $4 OFFSET $5`,
      [config.id, ...values(req), limit, offset]
    );
    return res.json({ runs: result.rows });
  } catch { return failed(res); }
});

connectorsRouter.get('/:name/runs/:runId/logs', async (req, res) => {
  try {
    const config = await ownedConfig(req);
    if (!config) return res.status(404).json(CONFIG_NOT_FOUND);
    const run = await postgresClient.query(
      `SELECT r.id FROM connector_run_history r WHERE r.id = $1 AND r.config_id = $2 AND ${connectorPredicate('r', 3)}`,
      [req.params.runId, config.id, ...values(req)]
    );
    if (!run.rows.length) return res.status(404).json(RUN_NOT_FOUND);
    const logs = await postgresClient.query(
      `SELECT id, "timestamp", level FROM connector_run_log_entries WHERE run_id = $1 ORDER BY "timestamp" ASC, sequence ASC`,
      [req.params.runId]
    );
    return res.json({ logs: logs.rows });
  } catch { return failed(res); }
});
