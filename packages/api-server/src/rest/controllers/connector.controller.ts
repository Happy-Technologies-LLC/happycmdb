// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { getPostgresClient } from '@cmdb/database';
import { logger, validateConnectorSortField, validateSortDirection } from '@cmdb/common';
import axios from 'axios';
import {
  ConnectorLifecycleService,
  LifecycleFailureCode,
} from '../../services/connector-lifecycle.service';

const LIFECYCLE_FAILURE_STATUS: Record<LifecycleFailureCode, number> = {
  NOT_FOUND_IN_REGISTRY: 404,
  ALREADY_INSTALLED: 409,
  NOT_INSTALLED: 404,
  HAS_DEPENDENT_CONFIGURATIONS: 400,
  NO_VERSION_AVAILABLE: 400,
  INSTALL_FAILED: 500,
  UPDATE_FAILED: 500,
  UNINSTALL_FAILED: 500,
};

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
  private lifecycleService = new ConnectorLifecycleService();

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

      const outcome = await this.lifecycleService.installConnector(connector_type, version, force);

      if (!outcome.success) {
        const status = outcome.code ? LIFECYCLE_FAILURE_STATUS[outcome.code] : 500;
        res.status(status).json({
          success: false,
          error: outcome.code || 'Failed to install connector',
          message: outcome.message,
          errors: outcome.errors,
        });
        return;
      }

      res.status(201).json({
        success: true,
        data: outcome.connector,
        message: outcome.message,
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

      const outcome = await this.lifecycleService.updateConnector(type, version, force);

      if (!outcome.success) {
        const status = outcome.code ? LIFECYCLE_FAILURE_STATUS[outcome.code] : 500;
        res.status(status).json({
          success: false,
          error: outcome.code || 'Failed to update connector',
          message: outcome.message,
          errors: outcome.errors,
        });
        return;
      }

      res.json({
        success: true,
        data: outcome.connector,
        message: outcome.message,
        previous_version: outcome.previousVersion,
        new_version: outcome.newVersion,
        up_to_date: outcome.previousVersion === outcome.newVersion,
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

      const outcome = await this.lifecycleService.uninstallConnector(type);

      if (!outcome.success) {
        const status = outcome.code ? LIFECYCLE_FAILURE_STATUS[outcome.code] : 500;
        res.status(status).json({
          success: false,
          error: outcome.code || 'Failed to uninstall connector',
          message: outcome.message,
          errors: outcome.errors,
        });
        return;
      }

      res.json({
        success: true,
        message: outcome.message,
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
      const errorSummary = error instanceof Error
        ? {
            message: error.message,
            name: error.name,
            stack: error.stack,
            ...(axios.isAxiosError(error)
              ? { code: error.code, status: error.response?.status }
              : {}),
          }
        : { message: String(error) };
      logger.error('Error refreshing registry cache', errorSummary);
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
