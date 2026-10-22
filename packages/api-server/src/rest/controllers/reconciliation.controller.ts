// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Reconciliation Controller
 * REST API endpoints for identity resolution and CI reconciliation
 */

import { Request, Response } from 'express';
import { logger } from '@cmdb/common';
import { getIdentityReconciliationEngine } from '@cmdb/identity-resolution';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { TransformedCI, IdentificationAttributes } from '@cmdb/integration-framework';
import { requestOrganizationId } from '../../middleware/auth.middleware';
import {
  deleteOrgRule, getOwnedFieldSources, getOwnedLineage, insertOrgRule, listOrgAuthorities, listOrgRules,
  listOwnedConflicts, updateOrgRule, upsertOrgAuthority,
} from '../../reconciliation/tenant-queries';
import { assertNoCIGap, CIGapError, CI_GAP_RESPONSE, readSingleCI } from '../../read-admission';
import { requestActor, sendJournalError } from '../../journal-http';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

      // v16 §3.1/§7.2: one journaled merge (a review field holds it: 202) or, unmatched, one journaled create (H-1).
      const outcome = await this.reconciliationEngine.mergeCI(discoveredCI, requestOrganizationId(req), requestActor(req), true);
      if (outcome === null) {
        res.status(404).json({ success: false, error: 'Not Found', message: 'CI not found' });
        return;
      }
      if (outcome.action === 'pending_review') {
        res.status(202).json({ success: true, data: { ci_id: outcome.ci_id, status: 'pending_review',
          conflict_ids: outcome.conflict_ids, correlation_id: outcome.correlation_id } });
        return;
      }
      res.json({
        success: true,
        data: { ci_id: outcome.ci_id, action: outcome.action, correlation_id: outcome.correlation_id },
        message: 'CI reconciled successfully'
      });
    } catch (error) {
      if (sendJournalError(res, error)) return;
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
          created_at: new Date(row.created_at),
          // v16 §7: typed values and the revision (content hash) a resolve must present
          field_name: row.field_name, source_name: row.source_name, incoming_value: row.incoming_json,
          target_value: row.target_json, revision: row.content_hash, detected_by: row.detected_by
        })),
        pagination: {
          total: result.total,
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
      const { resolution, expected_revision, merged_data } = req.body;
      // v16 §7.4: missing/foreign conflict or CI share one 404; a stale or wrong revision is 409.
      const resolved = await this.reconciliationEngine.resolveConflict(requestOrganizationId(req), requestActor(req),
        req.params['id']!, resolution, expected_revision, merged_data);
      if (resolved === null) {
        res.status(404).json({ success: false, error: 'Not Found', message: 'Conflict not found' });
        return;
      }
      res.json({
        success: true,
        data: { conflict_id: req.params['id'], resolution, status: resolved.status, correlation_id: resolved.correlation_id },
        message: 'Conflict resolved successfully'
      });
    } catch (error) {
      if (sendJournalError(res, error)) return;
      logger.error('Error resolving conflict', error);
      res.status(500).json({ success: false, error: 'Failed to resolve conflict' });
    }
  }

  /** GET /api/v1/reconciliation/rules: the caller organization's rules (v16 §8). */
  async listRules(req: Request, res: Response): Promise<void> {
    try {
      res.json({ success: true, data: (await listOrgRules(this.postgresClient, requestOrganizationId(req))).rows });
    } catch (error) {
      logger.error('Error listing rules', error);
      res.status(500).json({ success: false, error: 'Failed to list rules' });
    }
  }

  /**
   * POST /rules creates (O, name); PUT/DELETE /rules/:id change only O's rule: foreign, missing
   * and legacy global rules share one 404. A duplicate name in O is 409 (v16 §8).
   */
  async writeRule(req: Request, res: Response): Promise<void> {
    try {
      const organizationId = requestOrganizationId(req);
      const id = req.params['id'];
      if (id === undefined) {
        res.status(201).json({ success: true, data: (await insertOrgRule(this.postgresClient, organizationId, req.body)).rows[0] });
        return;
      }
      const result = !UUID.test(id) ? null : req.method === 'DELETE' ? await deleteOrgRule(this.postgresClient, id, organizationId)
        : await updateOrgRule(this.postgresClient, id, organizationId, req.body);
      if (!result?.rows.length) res.status(404).json({ success: false, error: 'Not Found', message: 'Rule not found' });
      else if (req.method === 'DELETE') res.status(204).end();
      else res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        res.status(409).json({ success: false, error: 'Conflict', message: 'Rule name already exists' });
        return;
      }
      logger.error('Error writing rule', error);
      res.status(500).json({ success: false, error: 'Failed to write rule' });
    }
  }

  /** GET /api/v1/reconciliation/source-authorities: the caller organization's authorities. */
  async listSourceAuthorities(req: Request, res: Response): Promise<void> {
    try {
      res.json({ success: true, data: (await listOrgAuthorities(this.postgresClient, requestOrganizationId(req))).rows });
    } catch (error) {
      logger.error('Error listing source authorities', error);
      res.status(500).json({ success: false, error: 'Failed to list source authorities' });
    }
  }

  /** PUT /api/v1/reconciliation/source-authorities/:source: upsert (O, source) only. */
  async updateSourceAuthority(req: Request, res: Response): Promise<void> {
    try {
      const result = await upsertOrgAuthority(this.postgresClient, requestOrganizationId(req), req.params['source']!,
        req.body.authority_score, req.body.description ?? null);
      res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      logger.error('Error updating source authority', error);
      res.status(500).json({ success: false, error: 'Failed to update source authority' });
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
      if (!await getNeo4jClient().getCI(ci_id, organizationId)) {
        await assertNoCIGap(organizationId, ci_id);
        res.status(404).json({ success: false, error: 'Not Found', message: 'CI not found' });
        return;
      }
      const result = await readSingleCI(organizationId, ci_id,
        () => getOwnedLineage(this.postgresClient, ci_id, organizationId));
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
      if (error instanceof CIGapError) {
        res.status(409).json(CI_GAP_RESPONSE);
        return;
      }
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
      if (!await getNeo4jClient().getCI(ci_id, organizationId)) {
        await assertNoCIGap(organizationId, ci_id);
        res.status(404).json({ success: false, error: 'Not Found', message: 'CI not found' });
        return;
      }
      const result = await readSingleCI(organizationId, ci_id,
        () => getOwnedFieldSources(this.postgresClient, ci_id, organizationId));
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
      if (error instanceof CIGapError) {
        res.status(409).json(CI_GAP_RESPONSE);
        return;
      }
      logger.error('Error getting CI field sources', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get field sources',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
}
