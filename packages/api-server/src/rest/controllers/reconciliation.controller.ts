// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Reconciliation Controller
 * REST API endpoints for identity resolution and CI reconciliation
 */

import { Request, Response } from 'express';
import { logger } from '@cmdb/common';
import { getIdentityReconciliationEngine } from '@cmdb/identity-resolution';
import { getPostgresClient } from '@cmdb/database';
import { TransformedCI, IdentificationAttributes } from '@cmdb/integration-framework';

export class ReconciliationController {
  private reconciliationEngine = getIdentityReconciliationEngine();
  private postgresClient = getPostgresClient();

  /**
   * POST /api/v1/reconciliation/match
   * Find duplicate/matching CIs based on identification attributes
   */
  async findMatches(req: Request, res: Response): Promise<void> {
    try {
      const { identifiers, source } = req.body;

      if (!identifiers || typeof identifiers !== 'object') {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'identifiers object is required'
        });
        return;
      }

      // Transform request into IdentificationAttributes format
      const idAttributes: IdentificationAttributes = {
        external_id: identifiers.external_id,
        serial_number: identifiers.serial_number,
        uuid: identifiers.uuid,
        mac_address: identifiers.mac_address,
        fqdn: identifiers.fqdn,
        hostname: identifiers.hostname,
        ip_address: identifiers.ip_address
      };

      // Create minimal TransformedCI object for matching context
      const discoveredCI: TransformedCI = {
        name: identifiers.hostname || identifiers.fqdn || 'unknown',
        ci_type: req.body.ci_type || 'server',
        source: source || 'manual',
        source_id: identifiers.external_id || 'unknown',
        identifiers: idAttributes,
        attributes: {},
        relationships: [],
        confidence_score: 100,
        environment: req.body.environment,
        status: 'active'
      };

      const match = await this.reconciliationEngine.findExistingCI(idAttributes, discoveredCI);

      if (!match) {
        res.json({
          success: true,
          data: null,
          message: 'No matching CI found'
        });
        return;
      }

      res.json({
        success: true,
        data: {
          ci_id: match.ci_id,
          confidence: match.confidence,
          match_strategy: match.match_strategy,
          matched_attributes: match.matched_attributes
        }
      });
    } catch (error) {
      logger.error('Error finding CI matches', error);
      res.status(500).json({
        success: false,
        error: 'Failed to find matches',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * POST /api/v1/reconciliation/merge
   * Merge/reconcile a discovered CI into the CMDB
   */
  async mergeCI(req: Request, res: Response): Promise<void> {
    try {
      const discoveredCI: TransformedCI = req.body;

      // Validate required fields
      if (!discoveredCI.name || !discoveredCI.ci_type || !discoveredCI.source) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Missing required fields: name, ci_type, source'
        });
        return;
      }

      // Perform reconciliation
      const ciId = await this.reconciliationEngine.reconcileCI(discoveredCI);

      res.json({
        success: true,
        data: {
          ci_id: ciId,
          action: ciId.includes('_') ? 'created' : 'updated'
        },
        message: 'CI reconciled successfully'
      });
    } catch (error) {
      logger.error('Error merging CI', error);
      res.status(500).json({
        success: false,
        error: 'Failed to merge CI',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/v1/reconciliation/conflicts
   * List pending reconciliation conflicts
   */
  async listConflicts(req: Request, res: Response): Promise<void> {
    try {
      const { status = 'pending', limit = 100, offset = 0 } = req.query;

      const limitNum = Math.min(parseInt(limit as string) || 100, 1000);
      const offsetNum = parseInt(offset as string) || 0;

      const result = await this.postgresClient.query(
        `SELECT id, ci_id, conflict_type, source_data, target_data,
                conflicting_fields, status, created_at
         FROM reconciliation_conflicts
         WHERE status = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [status, limitNum, offsetNum]
      );

      const total = await this.postgresClient.query(
        'SELECT COUNT(*) as count FROM reconciliation_conflicts WHERE status = $1',
        [status]
      );

      res.json({
        success: true,
        data: result.rows.map(row => ({
          id: row.id,
          ci_id: row.ci_id,
          conflict_type: row.conflict_type,
          source_data: row.source_data,
          target_data: row.target_data,
          conflicting_fields: row.conflicting_fields,
          status: row.status,
          created_at: row.created_at
        })),
        pagination: {
          total: parseInt(total.rows[0].count),
          count: result.rows.length,
          offset: offsetNum,
          limit: limitNum
        }
      });
    } catch (error) {
      logger.error('Error listing conflicts', error);
      res.status(500).json({
        success: false,
        error: 'Failed to list conflicts',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * POST /api/v1/reconciliation/conflicts/:id/resolve
   * Resolve a specific reconciliation conflict
   */
  async resolveConflict(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { resolution, merged_data } = req.body;

      if (!resolution || !['accept_source', 'accept_target', 'merge'].includes(resolution)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'resolution must be one of: accept_source, accept_target, merge'
        });
        return;
      }

      // Get conflict details
      const conflictResult = await this.postgresClient.query(
        'SELECT * FROM reconciliation_conflicts WHERE id = $1',
        [id]
      );

      if (conflictResult.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Conflict with ID '${id}' not found`
        });
        return;
      }

      // Update conflict status
      await this.postgresClient.query(
        `UPDATE reconciliation_conflicts
         SET status = 'resolved',
             resolution_data = $2,
             resolved_at = NOW()
         WHERE id = $1`,
        [id, JSON.stringify({ resolution, merged_data })]
      );

      res.json({
        success: true,
        data: {
          conflict_id: id,
          resolution: resolution,
          status: 'resolved'
        },
        message: 'Conflict resolved successfully'
      });
    } catch (error) {
      logger.error('Error resolving conflict', error);
      res.status(500).json({
        success: false,
        error: 'Failed to resolve conflict',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/v1/reconciliation/rules
   * List reconciliation rules and configuration
   */
  async listRules(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.postgresClient.query(
        `SELECT id, name, identification_rules, merge_strategies,
                enabled, created_at, updated_at
         FROM reconciliation_rules
         ORDER BY created_at DESC`
      );

      res.json({
        success: true,
        data: result.rows.map(row => ({
          id: row.id,
          name: row.name,
          identification_rules: row.identification_rules,
          merge_strategies: row.merge_strategies,
          enabled: row.enabled,
          created_at: row.created_at,
          updated_at: row.updated_at
        }))
      });
    } catch (error) {
      logger.error('Error listing reconciliation rules', error);
      res.status(500).json({
        success: false,
        error: 'Failed to list rules',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * POST /api/v1/reconciliation/rules
   * Create a new reconciliation rule
   */
  async createRule(req: Request, res: Response): Promise<void> {
    try {
      const { name, identification_rules, merge_strategies, enabled = true } = req.body;

      if (!name || !identification_rules || !Array.isArray(identification_rules)) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'name and identification_rules (array) are required'
        });
        return;
      }

      const result = await this.postgresClient.query(
        `INSERT INTO reconciliation_rules
         (name, identification_rules, merge_strategies, enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, NOW(), NOW())
         RETURNING *`,
        [name, JSON.stringify(identification_rules), JSON.stringify(merge_strategies || []), enabled]
      );

      res.status(201).json({
        success: true,
        data: {
          id: result.rows[0].id,
          name: result.rows[0].name,
          identification_rules: result.rows[0].identification_rules,
          merge_strategies: result.rows[0].merge_strategies,
          enabled: result.rows[0].enabled,
          created_at: result.rows[0].created_at
        },
        message: 'Reconciliation rule created successfully'
      });
    } catch (error) {
      logger.error('Error creating reconciliation rule', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create rule',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/v1/reconciliation/source-authorities
   * List source authority scores
   */
  async listSourceAuthorities(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.postgresClient.query(
        `SELECT source_name, authority_score, description
         FROM source_authority
         ORDER BY authority_score DESC`
      );

      res.json({
        success: true,
        data: result.rows.map(row => ({
          source_name: row.source_name,
          authority_score: row.authority_score,
          description: row.description
        }))
      });
    } catch (error) {
      logger.error('Error listing source authorities', error);
      res.status(500).json({
        success: false,
        error: 'Failed to list source authorities',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * PUT /api/v1/reconciliation/source-authorities/:source
   * Update source authority score
   */
  async updateSourceAuthority(req: Request, res: Response): Promise<void> {
    try {
      const { source } = req.params;
      const { authority_score, description } = req.body;

      if (!authority_score || authority_score < 1 || authority_score > 10) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'authority_score must be between 1 and 10'
        });
        return;
      }

      await this.postgresClient.query(
        `INSERT INTO source_authority (source_name, authority_score, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (source_name)
         DO UPDATE SET authority_score = $2, description = $3`,
        [source, authority_score, description || null]
      );

      res.json({
        success: true,
        data: {
          source_name: source,
          authority_score: authority_score,
          description: description
        },
        message: 'Source authority updated successfully'
      });
    } catch (error) {
      logger.error('Error updating source authority', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update source authority',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/v1/reconciliation/lineage/:ci_id
   * Get source lineage for a CI (which sources have contributed data)
   */
  async getCILineage(req: Request, res: Response): Promise<void> {
    try {
      const { ci_id } = req.params;

      const result = await this.postgresClient.query(
        `SELECT source_name, source_id, confidence_score,
                first_seen_at, last_seen_at
         FROM ci_source_lineage
         WHERE ci_id = $1
         ORDER BY last_seen_at DESC`,
        [ci_id]
      );

      res.json({
        success: true,
        data: {
          ci_id: ci_id,
          sources: result.rows.map(row => ({
            source_name: row.source_name,
            source_id: row.source_id,
            confidence_score: row.confidence_score,
            first_seen_at: row.first_seen_at,
            last_seen_at: row.last_seen_at
          }))
        }
      });
    } catch (error) {
      logger.error('Error getting CI lineage', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get lineage',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * GET /api/v1/reconciliation/field-sources/:ci_id
   * Get field-level source attribution (which source provided each field)
   */
  async getCIFieldSources(req: Request, res: Response): Promise<void> {
    try {
      const { ci_id } = req.params;

      const result = await this.postgresClient.query(
        `SELECT field_name, field_value, source_name, updated_at
         FROM ci_field_sources
         WHERE ci_id = $1
         ORDER BY field_name`,
        [ci_id]
      );

      res.json({
        success: true,
        data: {
          ci_id: ci_id,
          fields: result.rows.map(row => ({
            field_name: row.field_name,
            field_value: row.field_value,
            source_name: row.source_name,
            updated_at: row.updated_at
          }))
        }
      });
    } catch (error) {
      logger.error('Error getting CI field sources', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get field sources',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}
