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

export class DiscoveryDefinitionController {
  private service = new DiscoveryDefinitionService();

  /**
   * Create a new discovery definition
   * POST /api/v1/discovery/definitions
   */
  async createDefinition(req: Request, res: Response): Promise<void> {
    try {
      // Get user from auth context (assuming auth middleware sets req.user)
      const created_by = (req as any).user?.id || 'system';

      const definition = await this.service.createDefinition(req.body, created_by);

      res.status(201).json({
        success: true,
        data: definition,
        message: 'Discovery definition created successfully',
      });
    } catch (error) {
      logger.error('Error creating discovery definition', error);

      // Handle specific validation errors
      if (error instanceof Error && error.message.includes('Credential')) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: error.message,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to create discovery definition',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
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

      const definition = await this.service.getDefinition(id);

      if (!definition) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Discovery definition with ID '${id}' not found`,
        });
        return;
      }

      res.json({
        success: true,
        data: definition,
      });
    } catch (error) {
      logger.error('Error getting discovery definition', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve discovery definition',
        message: error instanceof Error ? error.message : 'Unknown error',
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

      const definitions = await this.service.listDefinitions(filters);

      res.json({
        success: true,
        data: definitions,
        count: definitions.length,
      });
    } catch (error) {
      logger.error('Error listing discovery definitions', error);
      res.status(500).json({
        success: false,
        error: 'Failed to list discovery definitions',
        message: error instanceof Error ? error.message : 'Unknown error',
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

      const definition = await this.service.updateDefinition(id, req.body);

      res.json({
        success: true,
        data: definition,
        message: 'Discovery definition updated successfully',
      });
    } catch (error) {
      logger.error('Error updating discovery definition', error);

      // Handle specific errors
      if (error instanceof Error) {
        if (error.message.includes('not found')) {
          res.status(404).json({
            success: false,
            error: 'Not Found',
            message: error.message,
          });
          return;
        }

        if (error.message.includes('Credential')) {
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
        error: 'Failed to update discovery definition',
        message: error instanceof Error ? error.message : 'Unknown error',
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

      await this.service.deleteDefinition(id);

      res.status(204).send();
    } catch (error) {
      logger.error('Error deleting discovery definition', error);

      if (error instanceof Error && error.message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: error.message,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to delete discovery definition',
        message: error instanceof Error ? error.message : 'Unknown error',
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
      const triggeredBy = (req as any).user?.id || 'system';

      const jobId = await this.service.runDefinition(id, triggeredBy);

      // Get definition details for response
      const definition = await this.service.getDefinition(id);

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
      logger.error('Error running discovery definition', error);

      if (error instanceof Error && error.message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: error.message,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to run discovery definition',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
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

      const definition = await this.service.enableSchedule(id);

      res.json({
        success: true,
        data: definition,
        message: 'Schedule enabled successfully',
      });
    } catch (error) {
      logger.error('Error enabling schedule', error);

      if (error instanceof Error) {
        if (error.message.includes('not found')) {
          res.status(404).json({
            success: false,
            error: 'Not Found',
            message: error.message,
          });
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
        message: error instanceof Error ? error.message : 'Unknown error',
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

      const definition = await this.service.disableSchedule(id);

      res.json({
        success: true,
        data: definition,
        message: 'Schedule disabled successfully',
      });
    } catch (error) {
      logger.error('Error disabling schedule', error);

      if (error instanceof Error && error.message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: error.message,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to disable schedule',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
