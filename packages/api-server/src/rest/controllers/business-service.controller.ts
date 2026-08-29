// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Business Service Controller
 * Handles CRUD operations for business services
 */

import { Request, Response } from 'express';
import { getPostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';

export class BusinessServiceController {
  private pgClient = getPostgresClient();

  /**
   * GET /api/v1/business-services
   * List all business services with optional filtering
   */
  async listBusinessServices(req: Request, res: Response): Promise<void> {
    try {
      const {
        search,
        service_classification,
        tbm_tower,
        business_criticality,
        operational_status,
        owned_by,
        page = 1,
        limit = 50
      } = req.query;

      const offset = (Number(page) - 1) * Number(limit);

      let query = 'SELECT * FROM dim_business_services WHERE 1=1';
      const params: any[] = [];
      let paramIndex = 1;

      if (search) {
        query += ` AND (name ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`;
        params.push(`%${search}%`);
        paramIndex++;
      }

      if (service_classification) {
        query += ` AND service_classification = $${paramIndex}`;
        params.push(service_classification);
        paramIndex++;
      }

      if (tbm_tower) {
        query += ` AND tbm_tower = $${paramIndex}`;
        params.push(tbm_tower);
        paramIndex++;
      }

      if (business_criticality) {
        query += ` AND business_criticality = $${paramIndex}`;
        params.push(business_criticality);
        paramIndex++;
      }

      if (operational_status) {
        query += ` AND operational_status = $${paramIndex}`;
        params.push(operational_status);
        paramIndex++;
      }

      if (owned_by) {
        query += ` AND owned_by = $${paramIndex}`;
        params.push(owned_by);
        paramIndex++;
      }

      query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(Number(limit), offset);

      const result = await this.pgClient.query(query, params);

      // Get total count for pagination
      let countQuery = 'SELECT COUNT(*) FROM dim_business_services WHERE 1=1';
      const countParams: any[] = [];
      let countParamIndex = 1;

      if (search) {
        countQuery += ` AND (name ILIKE $${countParamIndex} OR description ILIKE $${countParamIndex})`;
        countParams.push(`%${search}%`);
        countParamIndex++;
      }

      if (service_classification) {
        countQuery += ` AND service_classification = $${countParamIndex}`;
        countParams.push(service_classification);
        countParamIndex++;
      }

      if (tbm_tower) {
        countQuery += ` AND tbm_tower = $${countParamIndex}`;
        countParams.push(tbm_tower);
        countParamIndex++;
      }

      if (business_criticality) {
        countQuery += ` AND business_criticality = $${countParamIndex}`;
        countParams.push(business_criticality);
        countParamIndex++;
      }

      if (operational_status) {
        countQuery += ` AND operational_status = $${countParamIndex}`;
        countParams.push(operational_status);
        countParamIndex++;
      }

      if (owned_by) {
        countQuery += ` AND owned_by = $${countParamIndex}`;
        countParams.push(owned_by);
        countParamIndex++;
      }

      const countResult = await this.pgClient.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0].count);

      res.json({
        success: true,
        data: result.rows,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          totalPages: Math.ceil(total / Number(limit))
        }
      });
    } catch (error: any) {
      logger.error('Error listing business services', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to list business services',
        message: error.message
      });
    }
  }

  /**
   * GET /api/v1/business-services/:service_id
   * Get a specific business service
   */
  async getBusinessService(req: Request, res: Response): Promise<void> {
    try {
      const { service_id } = req.params;

      const result = await this.pgClient.query(
        'SELECT * FROM dim_business_services WHERE service_id = $1',
        [service_id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Business service not found'
        });
        return;
      }

      // Get mapped CIs count
      const ciCountResult = await this.pgClient.query(
        'SELECT COUNT(*) FROM ci_business_service_mappings WHERE service_id = $1',
        [service_id]
      );

      // Get dependencies count
      const depsCountResult = await this.pgClient.query(
        'SELECT COUNT(*) FROM business_service_dependencies WHERE service_id = $1',
        [service_id]
      );

      const service = {
        ...result.rows[0],
        mapped_cis_count: parseInt(ciCountResult.rows[0].count),
        dependencies_count: parseInt(depsCountResult.rows[0].count)
      };

      res.json({
        success: true,
        data: service
      });
    } catch (error: any) {
      logger.error('Error getting business service', { error, service_id: req.params.service_id });
      res.status(500).json({
        success: false,
        error: 'Failed to get business service',
        message: error.message
      });
    }
  }

  /**
   * POST /api/v1/business-services
   * Create a new business service
   */
  async createBusinessService(req: Request, res: Response): Promise<void> {
    try {
      const {
        service_id,
        name,
        description,
        service_classification,
        tbm_tower,
        business_criticality,
        operational_status = 'active',
        service_type,
        owned_by,
        managed_by,
        support_group,
        service_level_requirement,
        category,
        tags,
        related_ci_types,
        cost_allocation,
        metadata
      } = req.body;

      const result = await this.pgClient.query(
        `INSERT INTO dim_business_services (
          service_id, name, description, service_classification, tbm_tower,
          business_criticality, operational_status, service_type, owned_by,
          managed_by, support_group, service_level_requirement, category,
          tags, related_ci_types, cost_allocation, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING *`,
        [
          service_id, name, description, service_classification, tbm_tower,
          business_criticality, operational_status, service_type, owned_by,
          managed_by, support_group, service_level_requirement, category,
          tags, related_ci_types, cost_allocation ? JSON.stringify(cost_allocation) : null,
          metadata ? JSON.stringify(metadata) : null
        ]
      );

      logger.info('Business service created', { service_id, name });

      res.status(201).json({
        success: true,
        data: result.rows[0]
      });
    } catch (error: any) {
      logger.error('Error creating business service', { error, body: req.body });

      if (error.code === '23505') { // Unique violation
        res.status(409).json({
          success: false,
          error: 'Business service with this ID already exists'
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to create business service',
        message: error.message
      });
    }
  }

  /**
   * PATCH /api/v1/business-services/:service_id
   * Update an existing business service
   */
  async updateBusinessService(req: Request, res: Response): Promise<void> {
    try {
      const { service_id } = req.params;
      const updates = req.body;

      // Build dynamic UPDATE query
      const fields = Object.keys(updates);
      if (fields.length === 0) {
        res.status(400).json({
          success: false,
          error: 'No fields to update'
        });
        return;
      }

      const setClause = fields.map((field, index) => `${field} = $${index + 2}`).join(', ');
      const values = [service_id, ...fields.map(field => {
        // Stringify JSON fields
        if (['cost_allocation', 'metadata'].includes(field) && typeof updates[field] === 'object') {
          return JSON.stringify(updates[field]);
        }
        return updates[field];
      })];

      const result = await this.pgClient.query(
        `UPDATE dim_business_services
         SET ${setClause}, updated_at = NOW()
         WHERE service_id = $1
         RETURNING *`,
        values
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Business service not found'
        });
        return;
      }

      logger.info('Business service updated', { service_id, updates: fields });

      res.json({
        success: true,
        data: result.rows[0]
      });
    } catch (error: any) {
      logger.error('Error updating business service', { error, service_id: req.params.service_id });
      res.status(500).json({
        success: false,
        error: 'Failed to update business service',
        message: error.message
      });
    }
  }

  /**
   * DELETE /api/v1/business-services/:service_id
   * Delete a business service
   */
  async deleteBusinessService(req: Request, res: Response): Promise<void> {
    try {
      const { service_id } = req.params;

      const result = await this.pgClient.query(
        'DELETE FROM dim_business_services WHERE service_id = $1 RETURNING service_id, name',
        [service_id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Business service not found'
        });
        return;
      }

      logger.info('Business service deleted', { service_id });

      res.json({
        success: true,
        message: 'Business service deleted successfully',
        data: result.rows[0]
      });
    } catch (error: any) {
      logger.error('Error deleting business service', { error, service_id: req.params.service_id });
      res.status(500).json({
        success: false,
        error: 'Failed to delete business service',
        message: error.message
      });
    }
  }

  /**
   * GET /api/v1/business-services/:service_id/cis
   * Get all CIs mapped to a business service
   */
  async getMappedCIs(req: Request, res: Response): Promise<void> {
    try {
      const { service_id } = req.params;

      const result = await this.pgClient.query(
        `SELECT
          m.ci_id,
          m.mapping_type,
          m.confidence_score,
          m.created_at
        FROM ci_business_service_mappings m
        WHERE m.service_id = $1
        ORDER BY m.created_at DESC`,
        [service_id]
      );

      res.json({
        success: true,
        data: result.rows
      });
    } catch (error: any) {
      logger.error('Error getting mapped CIs', { error, service_id: req.params.service_id });
      res.status(500).json({
        success: false,
        error: 'Failed to get mapped CIs',
        message: error.message
      });
    }
  }

  /**
   * POST /api/v1/business-services/:service_id/cis
   * Map CIs to a business service
   */
  async mapCIsToService(req: Request, res: Response): Promise<void> {
    try {
      const { service_id } = req.params;
      const { ci_ids, mapping_type = 'supports', confidence_score = 1.0 } = req.body;

      const mappings = ci_ids.map((ci_id: string) => ({
        ci_id,
        service_id,
        mapping_type,
        confidence_score
      }));

      // Bulk insert
      const values = mappings.map((m, i) => {
        const base = i * 4;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
      }).join(', ');

      const params = mappings.flatMap(m => [m.ci_id, m.service_id, m.mapping_type, m.confidence_score]);

      const result = await this.pgClient.query(
        `INSERT INTO ci_business_service_mappings (ci_id, service_id, mapping_type, confidence_score)
         VALUES ${values}
         ON CONFLICT (ci_id, service_id, mapping_type) DO UPDATE
         SET confidence_score = EXCLUDED.confidence_score, updated_at = NOW()
         RETURNING *`,
        params
      );

      logger.info('CIs mapped to business service', { service_id, count: ci_ids.length });

      res.status(201).json({
        success: true,
        message: `${ci_ids.length} CIs mapped successfully`,
        data: result.rows
      });
    } catch (error: any) {
      logger.error('Error mapping CIs to service', { error, service_id: req.params.service_id });
      res.status(500).json({
        success: false,
        error: 'Failed to map CIs to service',
        message: error.message
      });
    }
  }

  /**
   * DELETE /api/v1/business-services/:service_id/cis/:ci_id
   * Unmap a CI from a business service
   */
  async unmapCIFromService(req: Request, res: Response): Promise<void> {
    try {
      const { service_id, ci_id } = req.params;

      const result = await this.pgClient.query(
        'DELETE FROM ci_business_service_mappings WHERE service_id = $1 AND ci_id = $2 RETURNING *',
        [service_id, ci_id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'CI mapping not found'
        });
        return;
      }

      logger.info('CI unmapped from business service', { service_id, ci_id });

      res.json({
        success: true,
        message: 'CI unmapped successfully'
      });
    } catch (error: any) {
      logger.error('Error unmapping CI from service', { error, service_id: req.params.service_id, ci_id: req.params.ci_id });
      res.status(500).json({
        success: false,
        error: 'Failed to unmap CI from service',
        message: error.message
      });
    }
  }

  /**
   * GET /api/v1/business-services/:service_id/dependencies
   * Get service dependencies
   */
  async getServiceDependencies(req: Request, res: Response): Promise<void> {
    try {
      const { service_id } = req.params;

      const result = await this.pgClient.query(
        `SELECT
          d.depends_on_service_id,
          s.name as depends_on_name,
          s.service_classification,
          s.business_criticality,
          d.dependency_type,
          d.created_at
        FROM business_service_dependencies d
        JOIN dim_business_services s ON d.depends_on_service_id = s.service_id
        WHERE d.service_id = $1
        ORDER BY d.created_at DESC`,
        [service_id]
      );

      res.json({
        success: true,
        data: result.rows
      });
    } catch (error: any) {
      logger.error('Error getting service dependencies', { error, service_id: req.params.service_id });
      res.status(500).json({
        success: false,
        error: 'Failed to get service dependencies',
        message: error.message
      });
    }
  }

  /**
   * POST /api/v1/business-services/:service_id/dependencies
   * Create a service dependency
   */
  async createServiceDependency(req: Request, res: Response): Promise<void> {
    try {
      const { service_id } = req.params;
      const { depends_on_service_id, dependency_type = 'technical' } = req.body;

      const result = await this.pgClient.query(
        `INSERT INTO business_service_dependencies (service_id, depends_on_service_id, dependency_type)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [service_id, depends_on_service_id, dependency_type]
      );

      logger.info('Service dependency created', { service_id, depends_on_service_id });

      res.status(201).json({
        success: true,
        data: result.rows[0]
      });
    } catch (error: any) {
      logger.error('Error creating service dependency', { error, service_id: req.params.service_id });

      if (error.code === '23505') { // Unique violation
        res.status(409).json({
          success: false,
          error: 'This dependency already exists'
        });
        return;
      }

      if (error.code === '23514') { // Check constraint violation (circular dependency)
        res.status(400).json({
          success: false,
          error: 'Cannot create circular dependency (service cannot depend on itself)'
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to create service dependency',
        message: error.message
      });
    }
  }

  /**
   * DELETE /api/v1/business-services/:service_id/dependencies/:depends_on_service_id
   * Delete a service dependency
   */
  async deleteServiceDependency(req: Request, res: Response): Promise<void> {
    try {
      const { service_id, depends_on_service_id } = req.params;

      const result = await this.pgClient.query(
        'DELETE FROM business_service_dependencies WHERE service_id = $1 AND depends_on_service_id = $2 RETURNING *',
        [service_id, depends_on_service_id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Dependency not found'
        });
        return;
      }

      logger.info('Service dependency deleted', { service_id, depends_on_service_id });

      res.json({
        success: true,
        message: 'Dependency deleted successfully'
      });
    } catch (error: any) {
      logger.error('Error deleting service dependency', { error, service_id: req.params.service_id });
      res.status(500).json({
        success: false,
        error: 'Failed to delete service dependency',
        message: error.message
      });
    }
  }

  /**
   * GET /api/v1/business-services/:service_id/health
   * Get service health metrics
   */
  async getServiceHealth(req: Request, res: Response): Promise<void> {
    try {
      const { service_id } = req.params;

      // Get incident metrics
      const incidentMetrics = await this.pgClient.query(
        `SELECT
          COUNT(*) FILTER (WHERE incident_date >= CURRENT_DATE - INTERVAL '7 days') as incidents_7d,
          COUNT(*) FILTER (WHERE incident_date >= CURRENT_DATE - INTERVAL '30 days') as incidents_30d,
          AVG(mttr_minutes) FILTER (WHERE incident_date >= CURRENT_DATE - INTERVAL '30 days') as avg_mttr_30d,
          SUM(sla_breaches) FILTER (WHERE incident_date >= CURRENT_DATE - INTERVAL '30 days') as sla_breaches_30d
        FROM fact_business_service_incidents
        WHERE service_id = $1`,
        [service_id]
      );

      // Get change metrics
      const changeMetrics = await this.pgClient.query(
        `SELECT
          COUNT(*) FILTER (WHERE change_date >= CURRENT_DATE - INTERVAL '7 days') as changes_7d,
          COUNT(*) FILTER (WHERE change_date >= CURRENT_DATE - INTERVAL '30 days') as changes_30d,
          SUM(successful_count)::float / NULLIF(SUM(change_count), 0) * 100 as success_rate_30d
        FROM fact_business_service_changes
        WHERE service_id = $1`,
        [service_id]
      );

      res.json({
        success: true,
        data: {
          incidents: incidentMetrics.rows[0],
          changes: changeMetrics.rows[0]
        }
      });
    } catch (error: any) {
      logger.error('Error getting service health', { error, service_id: req.params.service_id });
      res.status(500).json({
        success: false,
        error: 'Failed to get service health metrics',
        message: error.message
      });
    }
  }

  /**
   * GET /api/v1/business-services/:service_id/costs
   * Get service cost summary
   */
  async getServiceCosts(req: Request, res: Response): Promise<void> {
    try {
      const { service_id } = req.params;

      // Get costs from mapped CIs. CI-level TBM cost data lives on cmdb.dim_ci's
      // tbm_attributes JSONB (resource_tower / monthly_cost), not on tbm_cost_pools
      // (which has no ci_id/monthly_cost/resource_tower columns at all).
      // Aggregates are computed per-CI/per-tower in CTEs first, since Postgres rejects
      // an aggregate (SUM) nested directly inside another aggregate's (json_object_agg)
      // argument list.
      const result = await this.pgClient.query(
        `WITH ci_costs AS (
          SELECT
            m.ci_id,
            dc.tbm_attributes->>'resource_tower' AS resource_tower,
            (dc.tbm_attributes->>'monthly_cost')::numeric AS monthly_cost
          FROM ci_business_service_mappings m
          LEFT JOIN cmdb.dim_ci dc ON dc.ci_id = m.ci_id AND dc.is_current = TRUE
          WHERE m.service_id = $1
        ),
        tower_costs AS (
          SELECT resource_tower, SUM(monthly_cost) AS tower_cost
          FROM ci_costs
          WHERE resource_tower IS NOT NULL
          GROUP BY resource_tower
        )
        SELECT
          (SELECT COUNT(DISTINCT ci_id) FROM ci_costs) AS ci_count,
          (SELECT SUM(monthly_cost) FROM ci_costs) AS total_monthly_cost,
          (SELECT json_object_agg(resource_tower, tower_cost) FROM tower_costs) AS cost_by_tower`,
        [service_id]
      );

      res.json({
        success: true,
        data: result.rows[0] || { ci_count: 0, total_monthly_cost: 0, cost_by_tower: {} }
      });
    } catch (error: any) {
      logger.error('Error getting service costs', { error, service_id: req.params.service_id });
      res.status(500).json({
        success: false,
        error: 'Failed to get service costs',
        message: error.message
      });
    }
  }
}
