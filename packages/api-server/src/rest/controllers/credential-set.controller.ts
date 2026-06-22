// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { getCredentialSetService, getPostgresClient } from '@cmdb/database';
import {
  CredentialSetInput,
  CredentialSetUpdateInput,
  CredentialMatchContext,
  CredentialSetStrategy,
  logger,
} from '@cmdb/common';

/**
 * Credential Set Controller
 * Handles REST API requests for managing credential sets
 */
export class CredentialSetController {
  private credentialSetService;

  constructor() {
    const pool = getPostgresClient().pool;
    this.credentialSetService = getCredentialSetService(pool);
  }

  /**
   * POST /api/v1/credential-sets - Create credential set
   */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const input: CredentialSetInput = req.body;
      const createdBy = (req as any).user?.id || 'system'; // Get from auth middleware

      const credentialSet = await this.credentialSetService.create(input, createdBy);

      res.status(201).json({
        success: true,
        data: credentialSet,
        message: 'Credential set created successfully',
      });
    } catch (error) {
      logger.error('Error creating credential set', { error });

      // Check for duplicate name error
      if (error instanceof Error && error.message.includes('already exists')) {
        res.status(409).json({
          success: false,
          error: 'Conflict',
          message: error.message,
        });
        return;
      }

      // Check for invalid credential IDs error
      if (error instanceof Error && error.message.includes('do not exist')) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: error.message,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to create credential set',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/v1/credential-sets - List all credential sets with expanded credentials
   */
  async list(_req: Request, res: Response): Promise<void> {
    try {
      const credentialSets = await this.credentialSetService.list();

      res.status(200).json({
        success: true,
        data: credentialSets,
        count: credentialSets.length,
      });
    } catch (error) {
      logger.error('Error listing credential sets', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to list credential sets',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/v1/credential-sets/:id - Get credential set by ID
   */
  async getById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Credential set ID is required',
        });
        return;
      }

      // Get credential set with expanded credentials
      const credentialSet = await this.credentialSetService.getWithCredentials(id);

      if (!credentialSet) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Credential set with ID '${id}' not found`,
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: credentialSet,
      });
    } catch (error) {
      logger.error('Error getting credential set', { error, id: req.params['id'] });
      res.status(500).json({
        success: false,
        error: 'Failed to get credential set',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * PUT /api/v1/credential-sets/:id - Update credential set
   */
  async update(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Credential set ID is required',
        });
        return;
      }

      const input: CredentialSetUpdateInput = req.body;

      const credentialSet = await this.credentialSetService.update(id, input);

      res.status(200).json({
        success: true,
        data: credentialSet,
        message: 'Credential set updated successfully',
      });
    } catch (error) {
      logger.error('Error updating credential set', { error, id: req.params['id'] });

      // Check for not found error
      if (error instanceof Error && error.message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: error.message,
        });
        return;
      }

      // Check for duplicate name error
      if (error instanceof Error && error.message.includes('already exists')) {
        res.status(409).json({
          success: false,
          error: 'Conflict',
          message: error.message,
        });
        return;
      }

      // Check for invalid credential IDs error
      if (error instanceof Error && error.message.includes('do not exist')) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: error.message,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to update credential set',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * DELETE /api/v1/credential-sets/:id - Delete credential set
   */
  async delete(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Credential set ID is required',
        });
        return;
      }

      await this.credentialSetService.delete(id);

      res.status(204).send();
    } catch (error) {
      logger.error('Error deleting credential set', { error, id: req.params['id'] });

      // Check for not found error
      if (error instanceof Error && error.message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: error.message,
        });
        return;
      }

      // Check for in-use error
      if (error instanceof Error && error.message.includes('currently used')) {
        res.status(409).json({
          success: false,
          error: 'Conflict',
          message: error.message,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to delete credential set',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/v1/credential-sets/:id/select - Select credentials with strategy
   * Returns ordered list of credentials based on the set's strategy and context
   */
  async select(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Credential set ID is required',
        });
        return;
      }

      const context: CredentialMatchContext = req.body.context || {};
      const strategy: CredentialSetStrategy | undefined = req.body.strategy;

      const credentials = await this.credentialSetService.selectCredentials(
        id,
        context,
        strategy
      );

      // Redact sensitive credentials before returning
      const safeCredentials = credentials.map((credential) => ({
        ...credential,
        credentials: '***REDACTED***',
      }));

      res.status(200).json({
        success: true,
        data: safeCredentials,
        count: safeCredentials.length,
      });
    } catch (error) {
      logger.error('Error selecting credentials from set', { error, id: req.params['id'] });

      // Check for not found error
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
        error: 'Failed to select credentials',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
