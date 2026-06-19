// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector Loader Utility
 *
 * Scans the connectors directory and loads connector metadata into PostgreSQL
 * This runs at API server startup to ensure all built-in connectors are registered
 */

import fs from 'fs';
import path from 'path';
import { getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';

interface ConnectorMetadata {
  id: string;
  type: string;
  name: string;
  version: string;
  description: string;
  category: 'CONNECTOR' | 'DISCOVERY';
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  verified?: boolean;
  tags?: string[];
  resources?: any[];
  capabilities?: {
    extraction: boolean;
    transformation: boolean;
    loading: boolean;
    relationships: boolean;
    incremental: boolean;
    bidirectional: boolean;
  };
  connection_schema?: any;
  configuration_schema?: any;
  config_schema?: any;
  authentication?: {
    required: boolean;
    methods: string[];
    fields: Array<{
      name: string;
      label: string;
      type: string;
      required: boolean;
      sensitive: boolean;
      description?: string;
      default?: any;
    }>;
  };
}

export class ConnectorLoader {
  private connectorsPath: string;
  private postgresClient = getPostgresClient();

  constructor(connectorsPath?: string) {
    // Default to /app/packages/connectors in Docker, or resolve from current location
    this.connectorsPath = connectorsPath ||
      process.env['CONNECTORS_PATH'] ||
      path.resolve(__dirname, '../../../connectors');
  }

  /**
   * Load all connectors from the connectors directory
   */
  async loadAllConnectors(): Promise<void> {
    try {
      logger.info('Starting connector loader', { path: this.connectorsPath });

      if (!fs.existsSync(this.connectorsPath)) {
        logger.warn('Connectors directory not found', { path: this.connectorsPath });
        return;
      }

      const connectorDirs = fs.readdirSync(this.connectorsPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      logger.info('Found connector directories', { count: connectorDirs.length, connectors: connectorDirs });

      let loaded = 0;
      let errors = 0;

      for (const connectorDir of connectorDirs) {
        try {
          await this.loadConnector(connectorDir);
          loaded++;
        } catch (error) {
          logger.error(`Failed to load connector: ${connectorDir}`, error);
          errors++;
        }
      }

      logger.info('Connector loading completed', {
        total: connectorDirs.length,
        loaded,
        errors
      });

    } catch (error) {
      logger.error('Failed to load connectors', error);
      throw error;
    }
  }

  /**
   * Load a single connector by directory name
   */
  async loadConnector(connectorDir: string): Promise<void> {
    const connectorPath = path.join(this.connectorsPath, connectorDir);
    const metadataPath = path.join(connectorPath, 'connector.json');

    if (!fs.existsSync(metadataPath)) {
      logger.warn(`No connector.json found for ${connectorDir}`, { path: metadataPath });
      return;
    }

    const metadataContent = fs.readFileSync(metadataPath, 'utf-8');
    const metadata: ConnectorMetadata = JSON.parse(metadataContent);

    logger.info(`Loading connector: ${metadata.name}`, {
      type: metadata.type,
      version: metadata.version
    });

    // Transform authentication.fields to config_schema if needed
    const transformedMetadata = this.transformAuthenticationFields(metadata);

    await this.registerConnectorInDatabase(transformedMetadata, connectorPath);
  }

  /**
   * Transform authentication.fields array to config_schema object format
   * This ensures backward compatibility with connectors using authentication.fields
   */
  private transformAuthenticationFields(metadata: any): ConnectorMetadata {
    // If already has config_schema or configuration_schema, use as-is
    if (metadata.config_schema || metadata.configuration_schema || metadata.connection_schema) {
      return metadata;
    }

    // If has authentication.fields, transform to config_schema
    if (metadata.authentication?.fields && Array.isArray(metadata.authentication.fields)) {
      const config_schema: any = {};

      for (const field of metadata.authentication.fields) {
        config_schema[field.name] = {
          label: field.label || field.name,
          type: field.type === 'string' && field.sensitive ? 'password' : 'text',
          required: field.required || false,
          default: field.default,
          description: field.description,
        };
      }

      return {
        ...metadata,
        config_schema
      };
    }

    return metadata;
  }

  /**
   * Register connector metadata in PostgreSQL tables
   */
  private async registerConnectorInDatabase(
    metadata: ConnectorMetadata,
    installPath: string
  ): Promise<void> {
    const pool = this.postgresClient['pool'];

    try {
      // 1. Register in connector_registry_cache (for catalog/discovery)
      await pool.query(
        `INSERT INTO connector_registry_cache (
          connector_type, category, name, description,
          verified, latest_version, versions, author,
          homepage, repository, license, downloads, rating, tags,
          fetched_at, cache_expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW() + INTERVAL '365 days')
        ON CONFLICT (connector_type) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          latest_version = EXCLUDED.latest_version,
          versions = EXCLUDED.versions,
          fetched_at = NOW()`,
        [
          metadata.type,
          metadata.category || 'CONNECTOR',
          metadata.name,
          metadata.description || '',
          metadata.verified !== false, // Default to true for built-in connectors
          metadata.version,
          JSON.stringify([{
            version: metadata.version,
            releaseDate: new Date().toISOString(),
            changelog: 'Initial release',
            breakingChanges: false,
            sizeBytes: 0,
            checksum: ''
          }]),
          metadata.author || 'HappyCMDB',
          metadata.homepage || '',
          metadata.repository || '',
          metadata.license || 'MIT',
          0, // downloads
          5.0, // rating (5-star for built-in)
          metadata.tags || []
        ]
      );

      // 2. Register in installed_connectors (for active connectors)
      await pool.query(
        `INSERT INTO installed_connectors (
          connector_type, category, name, description,
          installed_version, latest_available_version,
          installed_at, updated_at, enabled, verified,
          install_path, metadata, capabilities, resources,
          configuration_schema, tags
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), true, true, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (connector_type) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          installed_version = EXCLUDED.installed_version,
          latest_available_version = EXCLUDED.latest_available_version,
          updated_at = NOW(),
          metadata = EXCLUDED.metadata,
          capabilities = EXCLUDED.capabilities,
          resources = EXCLUDED.resources,
          configuration_schema = EXCLUDED.configuration_schema`,
        [
          metadata.type,
          metadata.category || 'CONNECTOR',
          metadata.name,
          metadata.description || '',
          metadata.version,
          metadata.version,
          installPath,
          JSON.stringify(metadata),
          JSON.stringify(metadata.capabilities || {
            extraction: true,
            transformation: true,
            loading: true,
            relationships: true,
            incremental: false,
            bidirectional: false
          }),
          JSON.stringify(metadata.resources || []),
          JSON.stringify(metadata.config_schema || metadata.configuration_schema || metadata.connection_schema || {}),
          metadata.tags || []
        ]
      );

      logger.info(`Registered connector: ${metadata.name}`, {
        type: metadata.type,
        resources: metadata.resources?.length || 0
      });

    } catch (error) {
      logger.error(`Failed to register connector ${metadata.type} in database`, error);
      throw error;
    }
  }

  /**
   * Clear all connector registrations (useful for testing/reset)
   */
  async clearAllConnectors(): Promise<void> {
    const pool = this.postgresClient['pool'];

    await pool.query('DELETE FROM connector_registry_cache');
    await pool.query('DELETE FROM installed_connectors');

    logger.info('Cleared all connector registrations');
  }
}

/**
 * Load connectors at startup
 */
export async function loadConnectorsAtStartup(): Promise<void> {
  const loader = new ConnectorLoader();
  await loader.loadAllConnectors();
}
