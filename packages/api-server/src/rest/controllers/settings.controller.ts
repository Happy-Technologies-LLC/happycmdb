// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Settings Controller
 *
 * Backs the /api/v1/settings* endpoints routed by GeneralSettings,
 * NotificationSettings, DatabaseSettings, and DiscoverySettings
 * (web-ui/src/components/settings/*), plus POST /api/v1/discovery/test-connection.
 */

import { Response } from 'express';
import { getNeo4jClient, getPostgresClient, getRedisClient } from '@cmdb/database';
import { getEncryptionService, logger } from '@cmdb/common';
import { AuthenticatedRequest } from '../../middleware/auth.middleware';
import {
  DISCOVERY_PROVIDERS,
  DiscoveryProvider,
  testDiscoveryProviderConnection,
} from './settings/discovery-connection-test';

interface DatabaseStatusEntry {
  name: string;
  type: 'neo4j' | 'postgresql' | 'redis';
  status: 'connected' | 'disconnected' | 'error';
  details: {
    uri?: string;
    host?: string;
    port?: number;
    database?: string;
    version?: string;
  };
}

/**
 * Per-provider split of the DiscoverySettings.tsx `credentials` payload
 * into fields that must never be stored in plaintext.
 */
const PROVIDER_SECRET_FIELDS: Record<DiscoveryProvider, string[]> = {
  aws: ['accessKeyId', 'secretAccessKey'],
  azure: ['clientSecret'],
  gcp: ['credentials'],
  ssh: ['privateKey'],
};

export class SettingsController {
  /**
   * PUT /api/v1/settings
   */
  async updateGeneralSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user?._userId) {
        res.status(401).json({ success: false, error: 'Unauthorized', message: 'Authentication required' });
        return;
      }

      const settings = req.body as Record<string, unknown>;
      const pgClient = getPostgresClient();
      const result = await pgClient.query(
        `INSERT INTO user_settings (user_id, general_settings, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (user_id) DO UPDATE
         SET general_settings = $2::jsonb, updated_at = NOW()
         RETURNING general_settings`,
        [req.user._userId, JSON.stringify(settings)]
      );

      res.json({
        success: true,
        data: result.rows[0].general_settings,
        message: 'Settings saved successfully',
      });
    } catch (error) {
      logger.error('Failed to save general settings', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to Save Settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * PUT /api/v1/settings/notifications
   */
  async updateNotificationSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user?._userId) {
        res.status(401).json({ success: false, error: 'Unauthorized', message: 'Authentication required' });
        return;
      }

      const settings = req.body as Record<string, unknown>;
      const pgClient = getPostgresClient();
      const result = await pgClient.query(
        `INSERT INTO user_settings (user_id, notification_settings, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (user_id) DO UPDATE
         SET notification_settings = $2::jsonb, updated_at = NOW()
         RETURNING notification_settings`,
        [req.user._userId, JSON.stringify(settings)]
      );

      res.json({
        success: true,
        data: result.rows[0].notification_settings,
        message: 'Notification settings saved successfully',
      });
    } catch (error) {
      logger.error('Failed to save notification settings', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to Save Notification Settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/v1/settings/database (admin only -- enforced by route middleware)
   *
   * Reports live connectivity + safe config presence (host/port/database
   * name/version) for each backing store. Never reads or returns
   * passwords/secrets.
   */
  async getDatabaseStatus(_req: AuthenticatedRequest, res: Response): Promise<void> {
    const databases: DatabaseStatusEntry[] = [];

    try {
      const neo4jClient = getNeo4jClient();
      const session = neo4jClient.getSession();
      let version: string | undefined;
      try {
        const result = await session.run(
          `CALL dbms.components() YIELD name, versions WHERE name = 'Neo4j Kernel' RETURN versions[0] AS version`
        );
        version = result.records[0]?.get('version');
      } finally {
        await session.close();
      }
      databases.push({
        name: 'Neo4j',
        type: 'neo4j',
        status: 'connected',
        details: { uri: process.env['NEO4J_URI'] || 'bolt://localhost:7687', version },
      });
    } catch (error) {
      logger.error('Neo4j database status check failed', { error });
      databases.push({
        name: 'Neo4j',
        type: 'neo4j',
        status: 'error',
        details: { uri: process.env['NEO4J_URI'] || 'bolt://localhost:7687' },
      });
    }

    try {
      const pgClient = getPostgresClient();
      const result = await pgClient.query('SHOW server_version');
      databases.push({
        name: 'PostgreSQL',
        type: 'postgresql',
        status: 'connected',
        details: {
          host: process.env['POSTGRES_HOST'] || 'localhost',
          port: parseInt(process.env['POSTGRES_PORT'] || '5432', 10),
          database: process.env['POSTGRES_DB'] || 'cmdb_datamart',
          version: result.rows[0]?.server_version,
        },
      });
    } catch (error) {
      logger.error('PostgreSQL database status check failed', { error });
      databases.push({
        name: 'PostgreSQL',
        type: 'postgresql',
        status: 'error',
        details: {
          host: process.env['POSTGRES_HOST'] || 'localhost',
          port: parseInt(process.env['POSTGRES_PORT'] || '5432', 10),
          database: process.env['POSTGRES_DB'] || 'cmdb_datamart',
        },
      });
    }

    try {
      const redisClient = getRedisClient();
      const info = await redisClient.getConnection().info('server');
      const version = info.match(/redis_version:([^\r\n]+)/)?.[1];
      databases.push({
        name: 'Redis',
        type: 'redis',
        status: 'connected',
        details: {
          host: process.env['REDIS_HOST'] || 'localhost',
          port: parseInt(process.env['REDIS_PORT'] || '6379', 10),
          version,
        },
      });
    } catch (error) {
      logger.error('Redis database status check failed', { error });
      databases.push({
        name: 'Redis',
        type: 'redis',
        status: 'error',
        details: {
          host: process.env['REDIS_HOST'] || 'localhost',
          port: parseInt(process.env['REDIS_PORT'] || '6379', 10),
        },
      });
    }

    // Intentionally not { success, data } -- matches DatabaseSettings.tsx's
    // `response.data.databases` read.
    res.json({ databases });
  }

  /**
   * PUT /api/v1/settings/discovery/:provider
   *
   * Splits the incoming credentials object into non-secret config (stored
   * as plain JSONB) and secret fields (AES-256-GCM encrypted via
   * @cmdb/common's EncryptionService and stored only as ciphertext).
   * Blank/omitted secret fields leave any previously-saved secret intact
   * rather than clearing it, matching the common "leave blank to keep
   * current value" credential-editing convention.
   */
  async updateDiscoveryProviderSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user?._userId) {
        res.status(401).json({ success: false, error: 'Unauthorized', message: 'Authentication required' });
        return;
      }

      const provider = req.params['provider'];
      if (!provider || !DISCOVERY_PROVIDERS.includes(provider as DiscoveryProvider)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `Unsupported discovery provider '${provider}'. Expected one of: ${DISCOVERY_PROVIDERS.join(', ')}`,
        });
        return;
      }

      const credentials = req.body?.credentials;
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Request body must include a credentials object',
        });
        return;
      }

      const secretFields = PROVIDER_SECRET_FIELDS[provider as DiscoveryProvider];
      const secretPart: Record<string, unknown> = {};
      const configPart: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(credentials as Record<string, unknown>)) {
        if (secretFields.includes(key)) {
          if (value !== undefined && value !== null && value !== '') {
            secretPart[key] = value;
          }
        } else {
          configPart[key] = value;
        }
      }

      const encryptedCredentials =
        Object.keys(secretPart).length > 0 ? getEncryptionService().encryptCredential(secretPart) : null;

      const pgClient = getPostgresClient();
      const result = await pgClient.query(
        `INSERT INTO discovery_provider_settings (user_id, provider, config, encrypted_credentials, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, NOW())
         ON CONFLICT (user_id, provider) DO UPDATE
         SET config = $3::jsonb,
             encrypted_credentials = COALESCE($4, discovery_provider_settings.encrypted_credentials),
             updated_at = NOW()
         RETURNING config, (encrypted_credentials IS NOT NULL) AS has_credentials, updated_at`,
        [req.user._userId, provider, JSON.stringify(configPart), encryptedCredentials]
      );

      const row = result.rows[0];
      res.json({
        success: true,
        data: {
          provider,
          config: row.config,
          hasCredentials: row.has_credentials,
          updatedAt: row.updated_at,
        },
        message: 'Discovery provider settings saved successfully',
      });
    } catch (error) {
      logger.error('Failed to save discovery provider settings', { error, provider: req.params['provider'] });
      res.status(500).json({
        success: false,
        error: 'Failed to Save Provider Settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/v1/discovery/test-connection
   */
  async testDiscoveryConnection(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!req.user?._userId) {
        res.status(401).json({ success: false, error: 'Unauthorized', message: 'Authentication required' });
        return;
      }

      const { provider, credentials } = (req.body || {}) as { provider?: string; credentials?: unknown };
      if (!provider || !DISCOVERY_PROVIDERS.includes(provider as DiscoveryProvider)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `provider must be one of: ${DISCOVERY_PROVIDERS.join(', ')}`,
        });
        return;
      }
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
        res.status(400).json({ success: false, error: 'Bad Request', message: 'A credentials object is required' });
        return;
      }

      const result = await testDiscoveryProviderConnection(provider, credentials as Record<string, unknown>);
      if (result.success) {
        res.json({ success: true, message: result.message, details: result.details });
      } else {
        res.status(400).json({ success: false, error: 'Connection Test Failed', message: result.message });
      }
    } catch (error) {
      logger.error('Discovery connection test failed unexpectedly', { error });
      res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
