// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { getUnifiedCredentialService, getPostgresClient } from '@cmdb/database';
import {
  UnifiedCredentialInput,
  UnifiedCredentialUpdateInput,
  CredentialMatchContext,
  AuthProtocol,
  CredentialScope,
  logger,
} from '@cmdb/common';
import type { AuthenticatedRequest } from '../../auth/types';
import { requestOrganizationId } from '../../middleware/auth.middleware';

/**
 * Unified Credential Controller
 * Handles REST API requests for managing protocol-based credentials
 */
export class UnifiedCredentialController {
  private credentialService;

  constructor() {
    this.credentialService = getUnifiedCredentialService(getPostgresClient().pool);
  }
  private owner(req: Request): [string, string] {
    const userId = (req as AuthenticatedRequest).user?._userId;
    if (!userId) throw new Error('Verified credential owner required');
    return [userId, requestOrganizationId(req)];
  }

  /**
   * POST /api/v1/credentials - Create credential
   */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const input: UnifiedCredentialInput = req.body;
      const [createdBy, organizationId] = this.owner(req);
      const credential = await this.credentialService.create(input, createdBy, organizationId);

      // Redact sensitive credentials before returning
      const safeCredential = {
        ...credential,
        credentials: '***REDACTED***',
      };

      res.status(201).json({
        success: true,
        data: safeCredential,
        message: 'Credential created successfully',
      });
    } catch (error) {
      logger.error('Error creating credential', { error });

      // Check for duplicate name error
      if (error instanceof Error && error.message.includes('already exists')) {
        res.status(409).json({
          success: false,
          error: 'Conflict',
          message: error.message,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to create credential',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/v1/credentials - List credentials (summaries only, no sensitive data)
   */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const filters = {
        protocol: req.query['protocol'] as AuthProtocol | undefined,
        scope: req.query['scope'] as CredentialScope | undefined,
        tags: req.query['tags'] ? (req.query['tags'] as string).split(',') : undefined,
        created_by: req.query['created_by'] as string | undefined,
        limit: req.query['limit'] ? parseInt(req.query['limit'] as string, 10) : undefined,
        offset: req.query['offset'] ? parseInt(req.query['offset'] as string, 10) : undefined,
      };

      const credentials = await this.credentialService.list(...this.owner(req), filters);

      res.status(200).json({
        success: true,
        data: credentials,
        count: credentials.length,
      });
    } catch (error) {
      logger.error('Error listing credentials', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to list credentials',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/v1/credentials/:id - Get credential by ID
   * Only the credential's verified owner and organization can read it.
   */
  async getById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Credential ID is required',
        });
        return;
      }

      const credential = await this.credentialService.getById(id, ...this.owner(req));

      if (!credential) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Credential not found',
        });
        return;
      }

      // Never expose decrypted credential material on API reads.
      const safeCredential = {
        ...credential,
        credentials: '***REDACTED***',
      };

      res.status(200).json({
        success: true,
        data: safeCredential,
      });
    } catch (error) {
      logger.error('Error getting credential', { error, id: req.params['id'] });
      res.status(500).json({
        success: false,
        error: 'Failed to get credential',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * PUT /api/v1/credentials/:id - Update credential
   */
  async update(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Credential ID is required',
        });
        return;
      }

      const input: UnifiedCredentialUpdateInput = req.body;

      const credential = await this.credentialService.update(id, input, ...this.owner(req));

      // Redact sensitive credentials before returning
      const safeCredential = {
        ...credential,
        credentials: '***REDACTED***',
      };

      res.status(200).json({
        success: true,
        data: safeCredential,
        message: 'Credential updated successfully',
      });
    } catch (error) {
      logger.error('Error updating credential', { error, id: req.params['id'] });

      // Check for not found error
      if (error instanceof Error && error.message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Credential not found',
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

      res.status(500).json({
        success: false,
        error: 'Failed to update credential',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * DELETE /api/v1/credentials/:id - Delete credential
   */
  async delete(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Credential ID is required',
        });
        return;
      }

      await this.credentialService.delete(id, ...this.owner(req));

      res.status(204).send();
    } catch (error) {
      logger.error('Error deleting credential', { error, id: req.params['id'] });

      // Check for not found error
      if (error instanceof Error && error.message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Credential not found',
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
        error: 'Failed to delete credential',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/v1/credentials/:id/validate - Validate credential
   */
  async validate(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'Credential ID is required',
        });
        return;
      }

      const result = await this.credentialService.validate(id, ...this.owner(req));
      if (result === null) {
        res.status(404).json({ success: false, error: 'Not Found', message: 'Credential not found' });
        return;
      }

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('Error validating credential', { error, id: req.params['id'] });
      res.status(500).json({
        success: false,
        error: 'Failed to validate credential',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/v1/credentials/match - Find best matching credential
   */
  async match(req: Request, res: Response): Promise<void> {
    try {
      const context: CredentialMatchContext = req.body;

      const result = await this.credentialService.findBestMatch(context, ...this.owner(req));

      if (!result) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'No matching credential found for the given context',
        });
        return;
      }

      // Redact sensitive credentials before returning
      const safeResult = {
        ...result,
        credential: {
          ...result.credential,
          credentials: '***REDACTED***',
        },
      };

      res.status(200).json({
        success: true,
        data: safeResult,
      });
    } catch (error) {
      logger.error('Error matching credentials', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to match credentials',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * POST /api/v1/credentials/rank - Rank all credentials by match
   */
  async rank(req: Request, res: Response): Promise<void> {
    try {
      const context: CredentialMatchContext = req.body;

      const results = await this.credentialService.rankCredentials(context, ...this.owner(req));

      // Redact sensitive credentials before returning
      const safeResults = results.map((result) => ({
        ...result,
        credential: {
          ...result.credential,
          credentials: '***REDACTED***',
        },
      }));

      res.status(200).json({
        success: true,
        data: safeResults,
        count: safeResults.length,
      });
    } catch (error) {
      logger.error('Error ranking credentials', { error });
      res.status(500).json({
        success: false,
        error: 'Failed to rank credentials',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * OAuth state/callback SQL lacks a verified owner and organization predicate.
   * Until secured, roles and API keys cannot authorize these writes.
   */
  async authorize(req: Request, res: Response): Promise<void> {
    const id = req.params['id']!;
    try {
      const credential = await this.credentialService.getById(id, ...this.owner(req));
      if (!credential) {
        res.status(404).json({ success: false, error: 'Not Found', message: 'Credential not found' });
        return;
      }
      res.status(403).json({ success: false, error: 'Forbidden', message: 'Credential OAuth authorization unavailable' });
    } catch (error) {
      logger.error('Error checking OAuth credential ownership', { error, id });
      res.status(500).json({ success: false, error: 'Failed to authorize credential' });
    }
  }

  async oauthCallback(_req: Request, res: Response): Promise<void> {
    res.status(403).json({ success: false, error: 'Forbidden', message: 'Credential OAuth callback unavailable' });
  }
}
