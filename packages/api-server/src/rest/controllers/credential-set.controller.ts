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
  errorClassFields,
  CredentialSetNotFoundError,
  DuplicateCredentialSetNameError,
  CredentialIdsNotFoundError,
  CredentialSetInUseError,
} from '@cmdb/common';
import type { AuthenticatedRequest } from '../../auth/types';
import { requestOrganizationId } from '../../middleware/auth.middleware';

/** SQLSTATE of a pg error, if it carries one. */
const sqlState = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;
// ON DELETE RESTRICT refusal: 23503 (foreign_key_violation, PostgreSQL <= 16), 23001 (restrict_violation, PostgreSQL 18, PGlite)
const isRestrictRefusal = (error: unknown): boolean => sqlState(error) === '23503' || sqlState(error) === '23001';

/**
 * A duplicate name: the typed service error, or a raw unique violation (23505). The only text echoed is the request's
 * own `name`, which the route validator has already limited to a 1-255 character string.
 */
const isDuplicateName = (error: unknown): boolean =>
  error instanceof DuplicateCredentialSetNameError || sqlState(error) === '23505';

const duplicateNameMessage = (req: Request): string => {
  const name = (req.body as { name?: unknown } | undefined)?.name;
  return typeof name === 'string'
    ? `Credential set with name '${name}' already exists`
    : 'Credential set name already exists';
};

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
  private owner(req: Request): [string, string] {
    const userId = (req as AuthenticatedRequest).user?._userId;
    if (!userId) throw new Error('Verified credential owner required');
    return [userId, requestOrganizationId(req)];
  }

  /**
   * POST /api/v1/credential-sets - Create credential set
   */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const input: CredentialSetInput = req.body;
      const [createdBy, organizationId] = this.owner(req);
      const credentialSet = await this.credentialSetService.create(input, createdBy, organizationId);

      res.status(201).json({
        success: true,
        data: credentialSet,
        message: 'Credential set created successfully',
      });
    } catch (error) {
      logger.error('Error creating credential set', { error: errorClassFields(error) });

      // Check for duplicate name error
      if (isDuplicateName(error)) {
        res.status(409).json({
          success: false,
          error: 'Conflict',
          message: duplicateNameMessage(req),
        });
        return;
      }

      // Check for invalid credential IDs error
      if (error instanceof CredentialIdsNotFoundError) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: error.clientMessage,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to create credential set',
        message: 'Internal error',
      });
    }
  }

  /**
   * GET /api/v1/credential-sets - List all credential sets with expanded credentials
   */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const credentialSets = await this.credentialSetService.list(...this.owner(req));

      res.status(200).json({
        success: true,
        data: credentialSets,
        count: credentialSets.length,
      });
    } catch (error) {
      logger.error('Error listing credential sets', { error: errorClassFields(error) });
      res.status(500).json({
        success: false,
        error: 'Failed to list credential sets',
        message: 'Internal error',
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
      const credentialSet = await this.credentialSetService.getWithCredentials(id, ...this.owner(req));

      if (!credentialSet) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Credential set not found',
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: credentialSet,
      });
    } catch (error) {
      logger.error('Error getting credential set', { error: errorClassFields(error), id: req.params['id'] });
      res.status(500).json({
        success: false,
        error: 'Failed to get credential set',
        message: 'Internal error',
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

      const credentialSet = await this.credentialSetService.update(id, input, ...this.owner(req));

      res.status(200).json({
        success: true,
        data: credentialSet,
        message: 'Credential set updated successfully',
      });
    } catch (error) {
      logger.error('Error updating credential set', { error: errorClassFields(error), id: req.params['id'] });

      // Check for not found error
      if (error instanceof CredentialSetNotFoundError) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Credential set not found',
        });
        return;
      }

      // Check for duplicate name error
      if (isDuplicateName(error)) {
        res.status(409).json({
          success: false,
          error: 'Conflict',
          message: duplicateNameMessage(req),
        });
        return;
      }

      // Check for invalid credential IDs error
      if (error instanceof CredentialIdsNotFoundError) {
        res.status(400).json({
          success: false,
          error: 'Bad Request',
          message: error.clientMessage,
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to update credential set',
        message: 'Internal error',
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

      await this.credentialSetService.delete(id, ...this.owner(req));

      res.status(204).send();
    } catch (error) {
      logger.error('Error deleting credential set', { error: errorClassFields(error), id: req.params['id'] });

      // Check for not found error
      if (error instanceof CredentialSetNotFoundError) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Credential set not found',
        });
        return;
      }

      // Check for in-use error
      if (error instanceof CredentialSetInUseError || isRestrictRefusal(error)) {
        res.status(409).json({
          success: false,
          error: 'Conflict',
          message: error instanceof CredentialSetInUseError
            ? error.clientMessage
            : 'Cannot delete credential set: it is currently in use',
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to delete credential set',
        message: 'Internal error',
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
        strategy,
        ...this.owner(req)
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
      // HAP-1814: class/code only; a member's decrypt or JSON.parse failure message can quote its decrypted plaintext.
      logger.error('Error selecting credentials from set', { error: errorClassFields(error), id: req.params['id'] });

      // Check for not found error
      if (error instanceof CredentialSetNotFoundError) {
        res.status(404).json({
          success: false,
          error: 'Not Found',
          message: 'Credential set not found',
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to select credentials',
        message: 'Internal error',
      });
    }
  }
}
