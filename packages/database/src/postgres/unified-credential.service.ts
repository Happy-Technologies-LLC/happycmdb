// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unified Credential Service
 *
 * Manages protocol-based credentials with affinity matching and validation.
 * This service replaces provider-specific credentials with standard authentication
 * protocols that can be used across different providers.
 *
 * Key Features:
 * - Protocol-based credential storage (OAuth2, API Key, SSH, AWS IAM, etc.)
 * - Affinity-based credential matching (network, hostname, OS, device type, etc.)
 * - Credential sets for rotation and fallback
 * - Encrypted storage using AES-256-GCM
 */

import { Pool } from 'pg';
import {
  UnifiedCredential,
  UnifiedCredentialInput,
  UnifiedCredentialUpdateInput,
  UnifiedCredentialSummary,
  CredentialMatchContext,
  CredentialMatchResult,
  CredentialValidationResult,
} from '@cmdb/common';
import { CredentialCRUDService, CredentialFilters } from './credential-services/crud.service';
import { CredentialAffinityService } from './credential-services/affinity.service';
import { CredentialValidationService } from './credential-services/validation.service';

/**
 * Unified Credential Service
 * Coordinates CRUD, affinity matching, and validation operations
 */
export class UnifiedCredentialService {
  private crudService: CredentialCRUDService;
  private affinityService: CredentialAffinityService;
  private validationService: CredentialValidationService;

  constructor(pool: Pool) {
    this.crudService = new CredentialCRUDService(pool);
    this.affinityService = new CredentialAffinityService(pool);
    this.validationService = new CredentialValidationService(pool);
  }

  // CRUD Operations
  async create(
    input: UnifiedCredentialInput,
    createdBy: string,
    organizationId: string
  ): Promise<UnifiedCredential> {
    return this.crudService.create(input, createdBy, organizationId);
  }

  async getById(id: string, createdBy: string, organizationId: string): Promise<UnifiedCredential | null> {
    return this.crudService.getById(id, createdBy, organizationId);
  }

  async list(
    createdBy: string,
    organizationId: string,
    filters?: CredentialFilters
  ): Promise<UnifiedCredentialSummary[]> {
    return this.crudService.list(createdBy, organizationId, filters);
  }

  async update(
    id: string,
    input: UnifiedCredentialUpdateInput,
    createdBy: string,
    organizationId: string
  ): Promise<UnifiedCredential> {
    return this.crudService.update(id, input, createdBy, organizationId);
  }

  async delete(id: string, createdBy: string, organizationId: string): Promise<void> {
    return this.crudService.delete(id, createdBy, organizationId);
  }

  // Affinity Matching
  async findBestMatch(
    context: CredentialMatchContext,
    createdBy: string,
    organizationId: string
  ): Promise<CredentialMatchResult | null> {
    return this.affinityService.findBestMatch(context, createdBy, organizationId);
  }

  async rankCredentials(
    context: CredentialMatchContext,
    createdBy: string,
    organizationId: string
  ): Promise<CredentialMatchResult[]> {
    return this.affinityService.rankCredentials(context, createdBy, organizationId);
  }

  calculateAffinityScore(
    credential: UnifiedCredential,
    context: CredentialMatchContext
  ): { score: number; reasons: string[] } {
    return this.affinityService.calculateAffinityScore(credential, context);
  }

  // Validation
  async validate(id: string, createdBy: string, organizationId: string): Promise<CredentialValidationResult | null> {
    return this.validationService.validate(id, createdBy, organizationId, (id) => this.getById(id, createdBy, organizationId));
  }

  async testConnection(id: string, createdBy: string, organizationId: string): Promise<boolean> {
    return this.validationService.testConnection(id, (id) => this.validate(id, createdBy, organizationId));
  }

  validateCredentialStructure(
    credential: UnifiedCredential
  ): CredentialValidationResult {
    return this.validationService.validateCredentialStructure(credential);
  }
}

// Singleton instance
let unifiedCredentialService: UnifiedCredentialService | null = null;

export function getUnifiedCredentialService(
  pool: Pool
): UnifiedCredentialService {
  if (!unifiedCredentialService) {
    unifiedCredentialService = new UnifiedCredentialService(pool);
  }
  return unifiedCredentialService;
}

// Re-export types for convenience
export type { CredentialFilters };
