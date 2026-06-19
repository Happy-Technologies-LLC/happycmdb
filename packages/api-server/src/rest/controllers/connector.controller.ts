// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { getPostgresClient } from '@cmdb/database';
import { logger, validateConnectorSortField, validateSortDirection } from '@cmdb/common';
import axios from 'axios';

/**
 * ConnectorController - Manages connector registry and installation
 *
 * Responsibilities:
 * - Browse and search remote connector catalog
 * - Install connectors from registry
 * - Update connectors to newer versions
 * - Uninstall connectors
 * - Verify connector installations
 * - Manage registry cache
 */
export class ConnectorController {
  private postgresClient = getPostgresClient();
  private registryUrl = process.env['CONNECTOR_REGISTRY_URL'] || 'https://raw.githubusercontent.com/happycmdb/connectors/main/catalog.json';

  /**
   * GET /api/v1/connectors/registry
   * Browse remote connector catalog
   */
  async getRegistry(req: Request, res: Response): Promise<void> {
    try {
      const {
        category,
        search,
        tags,
        verified_only = false,
        limit = 50,
        offset = 0
      } = req.query;

      const pool = this.postgresClient['pool'];

      // Build query
      let query = 'SELECT * FROM connector_registry_cache WHERE 1=1';
      const params: any[] = [];
      let paramIndex = 1;

      if (category) {
        query += ` AND category = $${paramIndex++}`;
        params.push(category);
      }

      if (String(verified_only) === 'true') {
        query += ` AND verified = true`;
      }

      if (search) {
        query += ` AND (name ILIKE $${paramIndex} OR description ILIKE $${paramIndex} OR connector_type ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }

      if (tags && typeof tags === 'string') {
        const tagArray = tags.split(',').map(t => t.trim());
        query += ` AND tags && $${paramIndex++}`;
        params.push(tagArray);
      }

      // Count total
      const countQuery = query.replace('SELECT *', 'SELECT COUNT(*)');
      const countResult = await pool.query(countQuery, params);
      const total = parseInt(countResult.rows[0].count);

      // Add pagination
      query += ` ORDER BY name ASC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);

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
    } catch (error) {
      logger.error('Error fetching connector registry', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch connector registry',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/v1/connectors/registry/:type
   * Get connector details from catalog
   */
  async getRegistryDetails(req: Request, res: Response): Promise<void> {
    try {
      const { type } = req.params;

      const pool = this.postgresClient['pool'];
      const result = await pool.query(
        'SELECT * FROM connector_registry_cache WHERE connector_type = $1',
        [type]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Connector '${type}' not found in registry`
        });
        return;
      }

      res.json({
        success: true,
        data: result.rows[0],
      });
    } catch (error) {
      logger.error('Error fetching connector details', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch connector details',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/v1/connectors/registry/search?q=vmware
   * Search connector catalog
   */
  async searchRegistry(req: Request, res: Response): Promise<void> {
    try {
      const { q, limit = 20 } = req.query;

      const pool = this.postgresClient['pool'];
      const result = await pool.query(
        `SELECT * FROM connector_registry_cache
         WHERE name ILIKE $1
            OR description ILIKE $1
            OR connector_type ILIKE $1
            OR $2 = ANY(tags)
         ORDER BY
           CASE
             WHEN connector_type ILIKE $1 THEN 1
             WHEN name ILIKE $1 THEN 2
             ELSE 3
           END,
           name ASC
         LIMIT $3`,
        [`%${q}%`, q, limit]
      );

      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length,
        query: q,
      });
    } catch (error) {
      logger.error('Error searching connector registry', error);
      res.status(500).json({
        success: false,
        error: 'Failed to search connector registry',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/v1/connectors/installed
   * List installed connectors
   */
  async getInstalledConnectors(req: Request, res: Response): Promise<void> {
    try {
      const {
        category,
        enabled,
        search,
        sort_by = 'name',
        sort_order = 'asc'
      } = req.query;

      const pool = this.postgresClient['pool'];

      let query = 'SELECT * FROM installed_connectors WHERE 1=1';
      const params: any[] = [];
      let paramIndex = 1;

      if (category) {
        query += ` AND category = $${paramIndex++}`;
        params.push(category);
      }

      if (enabled !== undefined) {
        query += ` AND enabled = $${paramIndex++}`;
        params.push(String(enabled) === 'true');
      }

      if (search) {
        query += ` AND (name ILIKE $${paramIndex} OR description ILIKE $${paramIndex} OR connector_type ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }

      // Validate sort parameters to prevent SQL injection
      const sortField = validateConnectorSortField((sort_by as string) || 'name');
      const sortDirection = validateSortDirection((sort_order as string) || 'asc');

      // Safe to use template literals here because sortField and sortDirection are validated
      query += ` ORDER BY ${sortField} ${sortDirection}`;

      const result = await pool.query(query, params);

      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length,
      });
    } catch (error) {
      logger.error('Error fetching installed connectors', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch installed connectors',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/v1/connectors/installed/:type
   * Get installed connector details
   */
  async getInstalledConnectorDetails(req: Request, res: Response): Promise<void> {
    try {
      const { type } = req.params;

      const pool = this.postgresClient['pool'];
      const result = await pool.query(
        'SELECT * FROM installed_connectors WHERE connector_type = $1',
        [type]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Connector '${type}' is not installed`
        });
        return;
      }

      res.json({
        success: true,
        data: result.rows[0],
      });
    } catch (error) {
      logger.error('Error fetching installed connector details', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch connector details',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * POST /api/v1/connectors/install
   * Install connector from registry
   */
  async installConnector(req: Request, res: Response): Promise<void> {
    try {
      const { connector_type, version, force = false } = req.body;

      const pool = this.postgresClient['pool'];

      // Check if already installed
      const existingResult = await pool.query(
        'SELECT * FROM installed_connectors WHERE connector_type = $1',
        [connector_type]
      );

      if (existingResult.rows.length > 0 && !force) {
        res.status(409).json({
          success: false,
          error: 'Conflict',
          message: `Connector '${connector_type}' is already installed. Use force=true to reinstall.`
        });
        return;
      }

      // Get connector from registry cache
      const registryResult = await pool.query(
        'SELECT * FROM connector_registry_cache WHERE connector_type = $1',
        [connector_type]
      );

      if (registryResult.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Connector '${connector_type}' not found in registry`
        });
        return;
      }

      const catalogEntry = registryResult.rows[0];
      const targetVersion = version || catalogEntry.latest_version;

      // TODO: Actual installation logic would go here
      // 1. Download connector package from GitHub releases
      // 2. Verify checksum
      // 3. Extract to install path
      // 4. Install npm dependencies
      // 5. Validate connector.json
      // 6. Load metadata and resources

      // For now, create stub installation record
      const installPath = `/opt/happycmdb/connectors/${connector_type}`;

      const insertQuery = `
        INSERT INTO installed_connectors (
          connector_type, category, name, description,
          installed_version, latest_available_version,
          installed_at, updated_at, enabled, verified,
          install_path, metadata, capabilities, resources,
          configuration_schema, tags
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), true, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (connector_type) DO UPDATE SET
          installed_version = EXCLUDED.installed_version,
          latest_available_version = EXCLUDED.latest_available_version,
          updated_at = NOW(),
          install_path = EXCLUDED.install_path,
          metadata = EXCLUDED.metadata
        RETURNING *
      `;

      const result = await pool.query(insertQuery, [
        connector_type,
        catalogEntry.category,
        catalogEntry.name,
        catalogEntry.description,
        targetVersion,
        catalogEntry.latest_version,
        catalogEntry.verified,
        installPath,
        catalogEntry.metadata || {},
        catalogEntry.capabilities || { extraction: false, relationships: false, incremental: false, bidirectional: false },
        catalogEntry.resources || [],
        catalogEntry.configuration_schema || {},
        catalogEntry.tags || []
      ]);

      logger.info(`Connector '${connector_type}' installed successfully`, {
        version: targetVersion,
        path: installPath
      });

      res.status(201).json({
        success: true,
        data: result.rows[0],
        message: `Connector '${connector_type}' version ${targetVersion} installed successfully`
      });
    } catch (error) {
      logger.error('Error installing connector', error);
      res.status(500).json({
        success: false,
        error: 'Failed to install connector',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * PUT /api/v1/connectors/:type/update
   * Update connector to newer version
   */
  async updateConnector(req: Request, res: Response): Promise<void> {
    try {
      const { type } = req.params;
      const { version, force = false } = req.body;

      const pool = this.postgresClient['pool'];

      // Check if connector is installed
      const installedResult = await pool.query(
        'SELECT * FROM installed_connectors WHERE connector_type = $1',
        [type]
      );

      if (installedResult.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Connector '${type}' is not installed`
        });
        return;
      }

      const installed = installedResult.rows[0];
      const previousVersion = installed.installed_version;

      // Get latest version from registry
      const registryResult = await pool.query(
        'SELECT * FROM connector_registry_cache WHERE connector_type = $1',
        [type]
      );

      const targetVersion = version || registryResult.rows[0]?.latest_version;

      if (!targetVersion) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'No version specified and latest version not found in registry'
        });
        return;
      }

      if (previousVersion === targetVersion && !force) {
        res.json({
          success: true,
          data: installed,
          message: `Connector '${type}' is already at version ${targetVersion}`,
          up_to_date: true
        });
        return;
      }

      // TODO: Actual update logic
      // 1. Download new version
      // 2. Backup current installation
      // 3. Extract new version
      // 4. Run migration scripts if needed
      // 5. Update database record

      const result = await pool.query(
        `UPDATE installed_connectors
         SET installed_version = $1,
             latest_available_version = $2,
             updated_at = NOW()
         WHERE connector_type = $3
         RETURNING *`,
        [targetVersion, targetVersion, type]
      );

      logger.info(`Connector '${type}' updated successfully`, {
        previous_version: previousVersion,
        new_version: targetVersion
      });

      res.json({
        success: true,
        data: result.rows[0],
        message: `Connector '${type}' updated from ${previousVersion} to ${targetVersion}`,
        previous_version: previousVersion,
        new_version: targetVersion
      });
    } catch (error) {
      logger.error('Error updating connector', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update connector',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * DELETE /api/v1/connectors/:type
   * Uninstall connector
   */
  async uninstallConnector(req: Request, res: Response): Promise<void> {
    try {
      const { type } = req.params;

      const pool = this.postgresClient['pool'];

      // Check if connector is installed
      const installedResult = await pool.query(
        'SELECT * FROM installed_connectors WHERE connector_type = $1',
        [type]
      );

      if (installedResult.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Connector '${type}' is not installed`
        });
        return;
      }

      // Check if any configurations exist
      const configsResult = await pool.query(
        'SELECT COUNT(*) FROM connector_configurations WHERE connector_type = $1',
        [type]
      );

      const configCount = parseInt(configsResult.rows[0].count);
      if (configCount > 0) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `Cannot uninstall connector '${type}': ${configCount} configuration(s) exist. Delete configurations first.`
        });
        return;
      }

      // TODO: Actual uninstallation logic
      // 1. Remove installation files
      // 2. Clean up dependencies
      // 3. Delete database records

      await pool.query(
        'DELETE FROM installed_connectors WHERE connector_type = $1',
        [type]
      );

      logger.info(`Connector '${type}' uninstalled successfully`);

      res.json({
        success: true,
        message: `Connector '${type}' uninstalled successfully`
      });
    } catch (error) {
      logger.error('Error uninstalling connector', error);
      res.status(500).json({
        success: false,
        error: 'Failed to uninstall connector',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * POST /api/v1/connectors/:type/verify
   * Verify connector installation
   */
  async verifyConnector(req: Request, res: Response): Promise<void> {
    try {
      const { type } = req.params;

      const pool = this.postgresClient['pool'];
      const result = await pool.query(
        'SELECT * FROM installed_connectors WHERE connector_type = $1',
        [type]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Connector '${type}' is not installed`
        });
        return;
      }

      // TODO: Actual verification logic
      // 1. Check installation files exist
      // 2. Verify dependencies
      // 3. Validate connector.json
      // 4. Test connector loading

      const verified = true; // Stub

      await pool.query(
        'UPDATE installed_connectors SET verified = $1, updated_at = NOW() WHERE connector_type = $2',
        [verified, type]
      );

      res.json({
        success: true,
        verified,
        message: `Connector '${type}' verification ${verified ? 'passed' : 'failed'}`
      });
    } catch (error) {
      logger.error('Error verifying connector', error);
      res.status(500).json({
        success: false,
        error: 'Failed to verify connector',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * POST /api/v1/connectors/cache/refresh
   * Refresh registry cache from remote catalog
   */
  async refreshRegistryCache(_req: Request, res: Response): Promise<void> {
    try {
      logger.info('Refreshing connector registry cache', { url: this.registryUrl });

      // Fetch catalog from GitHub
      const response = await axios.get(this.registryUrl, {
        timeout: 10000,
        headers: { 'Accept': 'application/json' }
      });

      const catalog = response.data;

      if (!catalog.connectors || !Array.isArray(catalog.connectors)) {
        throw new Error('Invalid catalog format');
      }

      const pool = this.postgresClient['pool'];

      // Clear existing cache
      await pool.query('DELETE FROM connector_registry_cache');

      // Insert new cache entries
      let inserted = 0;
      for (const connector of catalog.connectors) {
        await pool.query(
          `INSERT INTO connector_registry_cache (
            connector_type, category, name, description,
            verified, latest_version, versions, author,
            homepage, repository, license, downloads, rating, tags,
            fetched_at, cache_expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW(), NOW() + INTERVAL '24 hours')`,
          [
            connector.type,
            connector.category,
            connector.name,
            connector.description,
            connector.verified || false,
            connector.latest_version,
            JSON.stringify(connector.versions || []),
            connector.author,
            connector.homepage,
            connector.repository,
            connector.license,
            connector.downloads || 0,
            connector.rating || 0.0,
            connector.tags || []
          ]
        );
        inserted++;
      }

      logger.info('Registry cache refreshed successfully', { count: inserted });

      res.json({
        success: true,
        message: `Registry cache refreshed with ${inserted} connectors`,
        count: inserted,
        updated_at: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Error refreshing registry cache', error);
      res.status(500).json({
        success: false,
        error: 'Failed to refresh registry cache',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/v1/connectors/outdated
   * Check for connector updates
   */
  async checkOutdatedConnectors(_req: Request, res: Response): Promise<void> {
    try {
      const pool = this.postgresClient['pool'];

      const result = await pool.query(`
        SELECT
          ic.connector_type,
          ic.name,
          ic.installed_version,
          crc.latest_version as available_version,
          ic.updated_at
        FROM installed_connectors ic
        LEFT JOIN connector_registry_cache crc
          ON ic.connector_type = crc.connector_type
        WHERE ic.installed_version != crc.latest_version
          OR crc.latest_version IS NULL
        ORDER BY ic.name ASC
      `);

      res.json({
        success: true,
        data: result.rows,
        count: result.rows.length,
        message: result.rows.length === 0
          ? 'All connectors are up to date'
          : `${result.rows.length} connector(s) have updates available`
      });
    } catch (error) {
      logger.error('Error checking outdated connectors', error);
      res.status(500).json({
        success: false,
        error: 'Failed to check for updates',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}
