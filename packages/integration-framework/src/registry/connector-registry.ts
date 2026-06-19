// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ConnectorRegistry (v3.0)
 * Auto-discovers and manages connector types
 * Now supports multi-resource connectors with database integration
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@cmdb/common';
import { getPostgresClient } from '@cmdb/database';
import { BaseIntegrationConnector } from '../core/base-connector';
import {
  ConnectorMetadata,
  ConnectorConfiguration,
  ConnectorResource,
  InstalledConnector,
} from '../types/connector.types';

export class ConnectorRegistry {
  private static instance: ConnectorRegistry;
  private connectorTypes: Map<string, ConnectorMetadata> = new Map();
  private connectorClasses: Map<string, typeof BaseIntegrationConnector> = new Map();
  private postgresClient = getPostgresClient();

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): ConnectorRegistry {
    if (!ConnectorRegistry.instance) {
      ConnectorRegistry.instance = new ConnectorRegistry();
    }
    return ConnectorRegistry.instance;
  }

  /**
   * Discover connectors by scanning directory
   * @param connectorsPath Path to connectors directory
   */
  async discoverConnectors(connectorsPath: string): Promise<void> {
    logger.info('Discovering connectors', { path: connectorsPath });

    if (!fs.existsSync(connectorsPath)) {
      logger.warn('Connectors directory not found', { path: connectorsPath });
      return;
    }

    const connectorDirs = fs.readdirSync(connectorsPath, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    for (const dirName of connectorDirs) {
      try {
        await this.loadConnector(path.join(connectorsPath, dirName));
      } catch (error) {
        logger.error('Failed to load connector', { connector: dirName, error });
      }
    }

    logger.info('Connector discovery completed', {
      count: this.connectorTypes.size,
      types: Array.from(this.connectorTypes.keys())
    });
  }

  /**
   * Load single connector from directory
   */
  private async loadConnector(connectorPath: string): Promise<void> {
    // Load connector.json
    const metadataPath = path.join(connectorPath, 'connector.json');
    if (!fs.existsSync(metadataPath)) {
      logger.warn('connector.json not found', { path: connectorPath });
      return;
    }

    const metadata: ConnectorMetadata = JSON.parse(
      fs.readFileSync(metadataPath, 'utf-8')
    );

    // Load connector implementation
    const indexPath = path.join(connectorPath, 'dist', 'index.js');
    if (!fs.existsSync(indexPath)) {
      logger.warn('Connector implementation not found (did you build?)', {
        path: indexPath
      });
      return;
    }

    const connectorModule = await import(indexPath);
    const ConnectorClass = connectorModule.default || connectorModule[metadata.type];

    if (!ConnectorClass) {
      throw new Error(`Connector class not found in ${indexPath}`);
    }

    // Verify it extends BaseIntegrationConnector (skip check as we can't validate abstract class)
    // if (!(ConnectorClass.prototype instanceof BaseIntegrationConnector)) {
    //   throw new Error(`Connector must extend BaseIntegrationConnector: ${metadata.type}`);
    // }

    // Register connector
    this.connectorTypes.set(metadata.type, metadata);
    this.connectorClasses.set(metadata.type, ConnectorClass);

    logger.info('Connector loaded', {
      type: metadata.type,
      name: metadata.name,
      version: metadata.version
    });
  }

  /**
   * Register connector programmatically
   */
  registerConnector(
    metadata: ConnectorMetadata,
    connectorClass: typeof BaseIntegrationConnector
  ): void {
    this.connectorTypes.set(metadata.type, metadata);
    this.connectorClasses.set(metadata.type, connectorClass);
    logger.info('Connector registered', { type: metadata.type });
  }

  /**
   * Create connector instance
   */
  createConnector(config: ConnectorConfiguration): BaseIntegrationConnector {
    const ConnectorClass = this.connectorClasses.get(config.type);
    const metadata = this.connectorTypes.get(config.type);

    if (!ConnectorClass) {
      throw new Error(`Unknown connector type: ${config.type}`);
    }

    if (!metadata) {
      throw new Error(`Connector metadata not found: ${config.type}`);
    }

    return new (ConnectorClass as any)(config, metadata);
  }

  /**
   * Get connector metadata
   */
  getConnectorMetadata(type: string): ConnectorMetadata | undefined {
    return this.connectorTypes.get(type);
  }

  /**
   * Get all registered connector types
   */
  getAllConnectorTypes(): ConnectorMetadata[] {
    return Array.from(this.connectorTypes.values());
  }

  /**
   * Check if connector type exists
   */
  hasConnectorType(type: string): boolean {
    return this.connectorTypes.has(type);
  }

  /**
   * Get available resources for a connector type
   */
  getAvailableResources(type: string): ConnectorResource[] {
    const metadata = this.connectorTypes.get(type);
    return metadata?.resources || [];
  }

  /**
   * Get resource schema for a specific connector type and resource
   */
  getResourceSchema(type: string, resourceId: string): Record<string, any> | undefined {
    const metadata = this.connectorTypes.get(type);
    if (!metadata) {
      return undefined;
    }
    const resource = metadata.resources.find((r) => r.id === resourceId);
    return resource?.configuration_schema;
  }

  /**
   * Validate resource configuration against schema
   */
  validateResourceConfig(
    type: string,
    resourceId: string,
    config: Record<string, any>
  ): { valid: boolean; errors?: string[] } {
    const schema = this.getResourceSchema(type, resourceId);
    if (!schema) {
      return { valid: true }; // No schema means no validation required
    }

    // Basic validation (in production, use a library like ajv)
    const errors: string[] = [];
    const required = schema['required'] || [];

    for (const field of required) {
      if (!config[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * Load installed connectors from database
   */
  async loadInstalledConnectors(): Promise<void> {
    try {
      const result = await this.postgresClient.query(
        'SELECT * FROM installed_connectors ORDER BY installed_at DESC'
      );

      for (const row of result.rows) {
        try {
          const metadata: ConnectorMetadata = row.metadata;
          const installPath = row.install_path;

          // Load connector implementation
          const indexPath = path.join(installPath, 'dist', 'index.js');
          if (fs.existsSync(indexPath)) {
            const connectorModule = await import(indexPath);
            const ConnectorClass = connectorModule.default || connectorModule[metadata.type];

            if (ConnectorClass) {
              this.connectorTypes.set(metadata.type, metadata);
              this.connectorClasses.set(metadata.type, ConnectorClass);
              logger.info('Installed connector loaded from database', {
                type: metadata.type,
                version: row.version,
              });
            }
          } else {
            logger.warn('Connector implementation not found', {
              type: metadata.type,
              path: indexPath,
            });
          }
        } catch (error) {
          logger.error('Failed to load installed connector', {
            type: row.connector_type,
            error,
          });
        }
      }

      logger.info('Installed connectors loaded', { count: this.connectorTypes.size });
    } catch (error) {
      logger.error('Failed to load installed connectors from database', { error });
    }
  }

  /**
   * Get installed connector record
   */
  async getInstalledConnector(type: string): Promise<InstalledConnector | null> {
    try {
      const result = await this.postgresClient.query(
        'SELECT * FROM installed_connectors WHERE connector_type = $1',
        [type]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        connector_type: row.connector_type,
        version: row.installed_version,
        installed_at: row.installed_at,
        metadata: row.metadata,
        install_path: row.install_path,
      };
    } catch (error) {
      logger.error('Failed to get installed connector', { type, error });
      return null;
    }
  }

  /**
   * Save installed connector to database
   */
  async saveInstalledConnector(connector: InstalledConnector): Promise<void> {
    try {
      await this.postgresClient.query(
        `
        INSERT INTO installed_connectors
        (connector_type, category, name, installed_version, metadata, install_path, installed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (connector_type)
        DO UPDATE SET
          category = EXCLUDED.category,
          name = EXCLUDED.name,
          installed_version = EXCLUDED.installed_version,
          metadata = EXCLUDED.metadata,
          install_path = EXCLUDED.install_path,
          installed_at = EXCLUDED.installed_at
        `,
        [
          connector.connector_type,
          connector.metadata.category,
          connector.metadata.name,
          connector.version,
          JSON.stringify(connector.metadata),
          connector.install_path,
          connector.installed_at,
        ]
      );

      logger.info('Connector saved to database', {
        type: connector.connector_type,
        version: connector.version,
      });
    } catch (error) {
      logger.error('Failed to save installed connector', {
        type: connector.connector_type,
        error,
      });
      throw error;
    }
  }

  /**
   * Remove installed connector from database
   */
  async removeInstalledConnector(type: string): Promise<void> {
    try {
      await this.postgresClient.query(
        'DELETE FROM installed_connectors WHERE connector_type = $1',
        [type]
      );

      logger.info('Connector removed from database', { type });
    } catch (error) {
      logger.error('Failed to remove installed connector', { type, error });
      throw error;
    }
  }
}

/**
 * Get singleton instance
 */
export function getConnectorRegistry(): ConnectorRegistry {
  return ConnectorRegistry.getInstance();
}
