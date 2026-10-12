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
import { requestOrganizationId } from '../../middleware/auth.middleware';
import {
  countOwnedConflicts, getOwnedConflict, getOwnedFieldSources, getOwnedLineage,
  listOwnedConflicts, updateOwnedConflict
} from '../../reconciliation/tenant-queries';

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

      const match = await this.reconciliationEngine.findExistingCI(idAttributes, discoveredCI, requestOrganizationId(req));

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
      const ciId = await this.reconciliationEngine.reconcileCI(discoveredCI, requestOrganizationId(req), false);
      if (ciId === null) {
        res.status(404).json({ success: false, error: 'Not Found', message: 'CI not found' });
        return;
      }

      res.json({
        success: true,
        data: {
          ci_id: ciId,
          action: 'updated'
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
      const organizationId = requestOrganizationId(req);
      const { status = 'pending', limit = 100, offset = 0 } = req.query;

      const limitNum = Math.min(parseInt(limit as string) || 100, 1000);
      const offsetNum = parseInt(offset as string) || 0;

      const result = await listOwnedConflicts(this.postgresClient, status as string, limitNum, offsetNum, organizationId);
      const total = await countOwnedConflicts(this.postgresClient, status as string, organizationId);

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
      const organizationId = requestOrganizationId(req);
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

      // Both detail access and the write must be scoped; ownership can change between statements.
      const conflictResult = await getOwnedConflict(this.postgresClient, id, organizationId);
      if (conflictResult.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Conflict not found'
        });
        return;
      }

      const updated = await updateOwnedConflict(
        this.postgresClient, id, organizationId, JSON.stringify({ resolution, merged_data })
      );
      if (updated.rows.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Conflict not found'
        });
        return;
      }

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
   * GET /api/v1/reconciliation/lineage/:ci_id
   * Get source lineage for a CI (which sources have contributed data)
   */
  async getCILineage(req: Request, res: Response): Promise<void> {
    try {
      const organizationId = requestOrganizationId(req);
      const { ci_id } = req.params;
      const result = await getOwnedLineage(this.postgresClient, ci_id, organizationId);
      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Not Found', message: 'CI not found' });
        return;
      }

      res.json({
        success: true,
        data: {
          ci_id: ci_id,
          sources: result.rows.filter(row => row.source_name !== null).map(row => ({
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
      const organizationId = requestOrganizationId(req);
      const { ci_id } = req.params;
      const result = await getOwnedFieldSources(this.postgresClient, ci_id, organizationId);
      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Not Found', message: 'CI not found' });
        return;
      }
      res.json({
        success: true,
        data: {
          ci_id: ci_id,
          fields: result.rows.filter(row => row.field_name !== null).map(row => ({
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
