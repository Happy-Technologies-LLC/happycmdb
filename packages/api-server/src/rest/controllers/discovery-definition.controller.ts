// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery Definition Controller
 *
 * REST API controller for managing discovery definitions - reusable discovery configurations
 * that combine credentials, provider settings, and schedules.
 */

import { Request, Response } from 'express';
import { logger } from '@cmdb/common';
import { DiscoveryDefinitionService } from '../../services/discovery-definition.service';
import type { AuthenticatedRequest } from '../../auth/types';
import { requestOrganizationId } from '../../middleware/auth.middleware';

const DEFINITION_NOT_FOUND = { success: false, error: 'Not Found', message: 'Discovery definition not found' };
const CREDENTIAL_NOT_FOUND = { success: false, error: 'Not Found', message: 'Credential not found' };

export class DiscoveryDefinitionController {
  private service = new DiscoveryDefinitionService();

  /**
   * Create a new discovery definition
   * POST /api/v1/discovery/definitions
   */
  async createDefinition(req: Request, res: Response): Promise<void> {
    try {
      // Get user from auth context (assuming auth middleware sets req.user)
      const created_by = (req as AuthenticatedRequest).user?._userId || 'system';

      const definition = await this.service.createDefinition(req.body, created_by, requestOrganizationId(req));

      res.status(201).json({
        success: true,
        data: definition,
        message: 'Discovery definition created successfully',
      });
    } catch (error) {
      logger.error('Error creating discovery definition');

      if (error instanceof Error && (error.message === 'Invalid discovery scan configuration' ||
        error.message === 'Discovery provider requires credential')) {
        res.status(400).json({ success: false, error: 'Bad Request', message: error.message });
        return;
      }
      if (error instanceof Error && error.message.toLowerCase().includes('credential') &&
          error.message.toLowerCase().includes('not found')) {
        res.status(404).json(CREDENTIAL_NOT_FOUND);
        return;
      }
      if (error instanceof Error && error.message.includes('Provider mismatch')) {
        res.status(400).json({ success: false, error: 'Bad Request', message: 'Provider mismatch' });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to create discovery definition',
        message: 'Internal error',
      });
    }
  }

  /** Tenant-scoped, admin-only inventory; no legacy configuration or credential payload. */
  async listUnsafeDefinitionIds(req: Request, res: Response): Promise<void> {
    try {
      const ids = await this.service.listUnsafeDefinitionIds(requestOrganizationId(req));
      res.json({ success: true, data: ids, count: ids.length });
    } catch {
      logger.error('Error listing unsafe discovery definitions');
      res.status(500).json({ success: false, error: 'Failed to list unsafe discovery definitions' });
    }
  }

  /**
   * Get a discovery definition by ID
   * GET /api/v1/discovery/definitions/:id
   */
  async getDefinition(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Definition ID is required',
        });
        return;
      }

      const definition = await this.service.getDefinition(id, requestOrganizationId(req));

      if (!definition) {
        res.status(404).json(DEFINITION_NOT_FOUND);
        return;
      }

      res.json({
        success: true,
        data: definition,
      });
    } catch (error) {
      logger.error('Error getting discovery definition');
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve discovery definition',
        message: 'Internal error',
      });
    }
  }

  /**
   * List all discovery definitions with optional filters
   * GET /api/v1/discovery/definitions
   */
  async listDefinitions(req: Request, res: Response): Promise<void> {
    try {
      const { provider, is_active, created_by } = req.query;

      const filters: any = {};

      if (provider) {
        filters.provider = provider;
      }

      if (is_active !== undefined) {
        filters.active = is_active === 'true';
      }

      if (created_by) {
        filters.created_by = created_by;
      }

      const definitions = await this.service.listDefinitions(filters, requestOrganizationId(req));

      res.json({
        success: true,
        data: definitions,
        count: definitions.length,
      });
    } catch (error) {
      logger.error('Error listing discovery definitions');
      res.status(500).json({
        success: false,
        error: 'Failed to list discovery definitions',
        message: 'Internal error',
      });
    }
  }

  /**
   * Update a discovery definition
   * PUT /api/v1/discovery/definitions/:id
   */
  async updateDefinition(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Definition ID is required',
        });
        return;
      }

      const definition = await this.service.updateDefinition(id, req.body, requestOrganizationId(req));

      res.json({
        success: true,
        data: definition,
        message: 'Discovery definition updated successfully',
      });
    } catch (error) {
      logger.error('Error updating discovery definition');

      // Handle specific errors
      if (error instanceof Error) {
        if (error.message === 'Invalid discovery scan configuration' ||
          error.message === 'Discovery provider requires credential') {
          res.status(400).json({ success: false, error: 'Bad Request', message: error.message });
          return;
        }
        if (error.message === 'Unsafe legacy discovery configuration requires migration') {
          res.status(409).json({ success: false, error: 'Discovery configuration requires migration' });
          return;
        }
        if (error.message.toLowerCase().includes('credential') && error.message.toLowerCase().includes('not found')) {
          res.status(404).json(CREDENTIAL_NOT_FOUND);
          return;
        }
        if (error.message.includes('not found')) {
          res.status(404).json(DEFINITION_NOT_FOUND);
          return;
        }
        if (error.message.includes('Provider mismatch')) {
          res.status(400).json({ success: false, error: 'Bad Request', message: 'Provider mismatch' });
          return;
        }
      }

      res.status(500).json({
        success: false,
        error: 'Failed to update discovery definition',
        message: 'Internal error',
      });
    }
  }

  /**
   * Delete a discovery definition
   * DELETE /api/v1/discovery/definitions/:id
   */
  async deleteDefinition(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Definition ID is required',
        });
        return;
      }

      await this.service.deleteDefinition(id, requestOrganizationId(req));

      res.status(204).send();
    } catch (error) {
      logger.error('Error deleting discovery definition');
      if (error instanceof Error && error.message === 'Unsafe legacy discovery configuration requires migration') {
        res.status(409).json({ success: false, error: 'Discovery configuration requires migration' });
        return;
      }

      if (error instanceof Error && error.message.includes('not found')) {
        res.status(404).json(DEFINITION_NOT_FOUND);
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to delete discovery definition',
        message: 'Internal error',
      });
    }
  }

  /**
   * Run a discovery definition
   * POST /api/v1/discovery/definitions/:id/run
   */
  async runDefinition(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Definition ID is required',
        });
        return;
      }

      // Get user from auth context (assuming auth middleware sets req.user)
      const triggeredBy = (req as AuthenticatedRequest).user?._userId || 'system';

      const organizationId = requestOrganizationId(req);
      const jobId = await this.service.runDefinition(id, triggeredBy, organizationId);
      const definition = await this.service.getDefinition(id, organizationId);

      res.status(202).json({
        success: true,
        data: {
          job_id: jobId,
          definition_id: id,
          provider: definition?.provider,
          status: 'pending',
          message: 'Discovery job queued successfully',
        },
        message: 'Discovery definition executed successfully',
      });
    } catch (error) {
      logger.error('Error running discovery definition');

      if (error instanceof Error && error.message === 'Credential not found') {
        res.status(404).json(CREDENTIAL_NOT_FOUND);
        return;
      }
      if (error instanceof Error && error.message.includes('not found')) {
        res.status(404).json(DEFINITION_NOT_FOUND);
        return;
      }
      if (error instanceof Error && error.message === 'Credential-backed discovery execution is unavailable') {
        res.status(409).json({ success: false, error: 'Credential-backed discovery execution unavailable' });
        return;
      }
      if (error instanceof Error && error.message === 'Unsafe legacy discovery configuration requires migration') {
        res.status(409).json({ success: false, error: 'Discovery configuration requires migration' });
        return;
      }
      res.status(500).json({ success: false, error: 'Failed to run discovery definition' });
    }
  }

  /**
   * Enable scheduled execution for a definition
   * POST /api/v1/discovery/definitions/:id/schedule/enable
   */
  async enableSchedule(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Definition ID is required',
        });
        return;
      }

      const definition = await this.service.enableSchedule(id, requestOrganizationId(req));

      res.json({
        success: true,
        data: definition,
        message: 'Schedule enabled successfully',
      });
    } catch (error) {
      logger.error('Error enabling schedule');

      if (error instanceof Error && error.message === 'Credential-backed discovery execution is unavailable') {
        res.status(409).json({ success: false, error: 'Credential-backed discovery execution unavailable' });
        return;
      }
      if (error instanceof Error && error.message === 'Unsafe legacy discovery configuration requires migration') {
        res.status(409).json({ success: false, error: 'Discovery configuration requires migration' });
        return;
      }

      if (error instanceof Error) {
        if (error.message.includes('not found')) {
          res.status(404).json(DEFINITION_NOT_FOUND);
          return;
        }

        if (error.message.includes('no schedule configured')) {
          res.status(400).json({
            success: false,
            error: 'Bad Request',
            message: error.message,
          });
          return;
        }
      }

      res.status(500).json({
        success: false,
        error: 'Failed to enable schedule',
        message: 'Internal error',
      });
    }
  }

  /**
   * Disable scheduled execution for a definition
   * POST /api/v1/discovery/definitions/:id/schedule/disable
   */
  async disableSchedule(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Definition ID is required',
        });
        return;
      }

      const definition = await this.service.disableSchedule(id, requestOrganizationId(req));

      res.json({
        success: true,
        data: definition,
        message: 'Schedule disabled successfully',
      });
    } catch (error) {
      logger.error('Error disabling schedule');
      if (error instanceof Error && error.message === 'Unsafe legacy discovery configuration requires migration') {
        res.status(409).json({ success: false, error: 'Discovery configuration requires migration' });
        return;
      }

      if (error instanceof Error && error.message.includes('not found')) {
        res.status(404).json(DEFINITION_NOT_FOUND);
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to disable schedule',
        message: 'Internal error',
      });
    }
  }
}
