// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { getPostgresClient } from '@cmdb/database';
import { logger, validateConnectorSortField, validateSortDirection } from '@cmdb/common';
import { publicInstalledConnector } from '../../services/public-installed-connector';

/**
 * Read-only connector registry and installed-template discovery.
 * Global lifecycle mutations are unavailable through the API.
 */
export class ConnectorController {
  private postgresClient = getPostgresClient();

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

      let query = `SELECT id, connector_type, category, name, description, installed_version,
        latest_available_version, installed_at, updated_at, enabled, verified, capabilities,
        resources, configuration_schema, tags FROM installed_connectors WHERE 1=1`;
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
        data: result.rows.map(publicInstalledConnector),
        count: result.rows.length,
      });
    } catch {
      logger.error('Error fetching installed connectors');
      res.status(500).json({ success: false, error: 'Failed to fetch installed connectors' });
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
        `SELECT id, connector_type, category, name, description, installed_version,
          latest_available_version, installed_at, updated_at, enabled, verified, capabilities,
          resources, configuration_schema, tags FROM installed_connectors WHERE connector_type = $1`,
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
        data: publicInstalledConnector(result.rows[0]),
      });
    } catch {
      logger.error('Error fetching installed connector details');
      res.status(500).json({ success: false, error: 'Failed to fetch connector details' });
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
