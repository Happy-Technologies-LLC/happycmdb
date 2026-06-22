// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { Request, Response } from 'express';
import { Pool } from 'pg';
import {
  getUnifiedCredentialService,
  getPostgresClient,
  getOAuthSubstrate,
  SERVICENOW_PROVIDER_ID,
} from '@cmdb/database';
import {
  UnifiedCredentialInput,
  UnifiedCredentialUpdateInput,
  CredentialMatchContext,
  AuthProtocol,
  CredentialScope,
  logger,
} from '@cmdb/common';

/**
 * Unified Credential Controller
 * Handles REST API requests for managing protocol-based credentials
 */
export class UnifiedCredentialController {
  private credentialService;
  private oauthPool: Pool;

  constructor() {
    const pool = getPostgresClient().pool;
    this.oauthPool = pool;
    this.credentialService = getUnifiedCredentialService(pool);
  }

  /**
   * POST /api/v1/credentials - Create credential
   */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const input: UnifiedCredentialInput = req.body;
      const createdBy = (req as any).user?.id || 'system'; // Get from auth middleware

      const credential = await this.credentialService.create(input, createdBy);

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

      const credentials = await this.credentialService.list(filters);

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
   * WARNING: Returns decrypted credentials - should be restricted to admins
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

      const credential = await this.credentialService.getById(id);

      if (!credential) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Credential with ID '${id}' not found`,
        });
        return;
      }

      // Redact sensitive credentials before returning
      // In a real implementation, you might check user permissions first
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

      const credential = await this.credentialService.update(id, input);

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

      await this.credentialService.delete(id);

      res.status(204).send();
    } catch (error) {
      logger.error('Error deleting credential', { error, id: req.params['id'] });

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

      const result = await this.credentialService.validate(id);

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

      const result = await this.credentialService.findBestMatch(context);

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

      const results = await this.credentialService.rankCredentials(context);

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
   * POST /api/v1/credentials/:id/oauth/authorize - Begin OAuth authorization for an oauth2 credential
   */
  async authorize(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const provider =
        typeof req.body.provider === 'string' && req.body.provider !== ''
          ? (req.body.provider as string)
          : SERVICENOW_PROVIDER_ID;

      const rawScopes = req.body.scopes ?? [];
      if (!Array.isArray(rawScopes) || !rawScopes.every((s) => typeof s === 'string')) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'scopes must be an array of strings',
        });
        return;
      }
      const scopes = rawScopes as string[];

      const credential = await this.credentialService.getById(id);

      if (credential === null) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: `Credential with ID '${id}' not found`,
        });
        return;
      }

      if (credential.protocol !== 'oauth2') {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'OAuth authorize is only valid for oauth2 credentials',
        });
        return;
      }

      const { url, state } = await getOAuthSubstrate(this.oauthPool).authorizationUrl({
        sourceId: id,
        providerId: provider,
        scopes,
      });

      res.status(200).json({
        success: true,
        data: {
          authorization_url: url,
          state,
        },
      });
    } catch (error) {
      logger.error('Error starting OAuth authorization', { error, id: req.params['id'] });
      res.status(500).json({
        success: false,
        error: 'Failed to start OAuth authorization',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * GET /api/v1/credentials/oauth/callback - Handle OAuth provider redirect callback
   */
  async oauthCallback(req: Request, res: Response): Promise<void> {
    try {
      if (typeof req.query['error'] === 'string' && req.query['error'] !== '') {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: `OAuth authorization failed: ${req.query['error']}`,
        });
        return;
      }

      const state = req.query['state'];
      const code = req.query['code'];

      if (typeof state !== 'string' || state === '' || typeof code !== 'string' || code === '') {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: 'state and code query parameters are required',
        });
        return;
      }

      const result = await getOAuthSubstrate(this.oauthPool).handleCallback({ state, code });

      res.status(200).json({
        success: true,
        data: {
          source_id: result.sourceId,
          connected: true,
        },
      });
    } catch (error) {
      logger.error('Error handling OAuth callback', { error });

      if (error instanceof Error && error.message.includes('invalid or expired OAuth state')) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: error.message,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to handle OAuth callback',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
