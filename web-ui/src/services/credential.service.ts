// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import axios, { AxiosInstance } from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

/**
 * Standard Authentication Protocols
 */
export type AuthProtocol =
  | 'oauth2'
  | 'api_key'
  | 'basic'
  | 'bearer'
  | 'aws_iam'
  | 'azure_sp'
  | 'gcp_sa'
  | 'ssh_key'
  | 'ssh_password'
  | 'certificate'
  | 'kerberos'
  | 'snmp_v2c'
  | 'snmp_v3'
  | 'winrm';

/**
 * Credential Scope
 */
export type CredentialScope =
  | 'cloud_provider'
  | 'ssh'
  | 'api'
  | 'network'
  | 'database'
  | 'container'
  | 'universal';

/**
 * Validation Status
 */
export type ValidationStatus = 'valid' | 'invalid' | 'expired' | 'unknown';

/**
 * Credential Set Strategy
 */
export type CredentialSetStrategy =
  | 'sequential'
  | 'parallel'
  | 'adaptive';

/**
 * Credential Affinity
 */
export interface CredentialAffinity {
  networks?: string[];
  hostname_patterns?: string[];
  os_types?: string[];
  device_types?: string[];
  environments?: string[];
  cloud_providers?: string[];
  priority?: number;
}

/**
 * Unified Credential
 */
export interface UnifiedCredential {
  id: string;
  name: string;
  description?: string;
  protocol: AuthProtocol;
  scope: CredentialScope;
  credentials: Record<string, any>;
  affinity: CredentialAffinity;
  tags: string[];
  created_by: string;
  created_at: Date;
  updated_at: Date;
  last_validated_at?: Date;
  validation_status?: ValidationStatus;
  usage_count?: number;
  connector_usage_count?: number;
}

/**
 * Unified Credential Summary
 */
export interface UnifiedCredentialSummary {
  id: string;
  name: string;
  description?: string;
  protocol: AuthProtocol;
  scope: CredentialScope;
  affinity: CredentialAffinity;
  tags: string[];
  created_at: Date;
  updated_at: Date;
  last_validated_at?: Date;
  validation_status?: ValidationStatus;
  usage_count?: number;
  connector_usage_count?: number;
}

/**
 * Unified Credential Input
 */
export interface UnifiedCredentialInput {
  name: string;
  description?: string;
  protocol: AuthProtocol;
  scope: CredentialScope;
  credentials: Record<string, any>;
  affinity?: CredentialAffinity;
  tags?: string[];
}

/**
 * Unified Credential Update Input
 */
export interface UnifiedCredentialUpdateInput {
  name?: string;
  description?: string;
  credentials?: Record<string, any>;
  affinity?: CredentialAffinity;
  tags?: string[];
}

/**
 * Credential Filters
 */
export interface CredentialFilters {
  protocol?: AuthProtocol;
  scope?: CredentialScope;
  tags?: string[];
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Credential List Response
 */
export interface CredentialListResponse {
  data: UnifiedCredentialSummary[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

/**
 * Credential Match Context
 */
export interface CredentialMatchContext {
  ip?: string;
  hostname?: string;
  os_type?: string;
  device_type?: string;
  environment?: string;
  cloud_provider?: string;
  required_protocol?: AuthProtocol;
  required_scope?: CredentialScope;
}

/**
 * Credential Match Result
 */
export interface CredentialMatchResult {
  credential: UnifiedCredential;
  score: number;
  reasons: string[];
}

/**
 * Credential Validation Result
 */
export interface CredentialValidationResult {
  valid: boolean;
  message: string;
  validated_at: Date;
  details?: Record<string, any>;
}

/**
 * Credential Set
 */
export interface CredentialSet {
  id: string;
  name: string;
  description?: string;
  credential_ids: string[];
  strategy: CredentialSetStrategy;
  stop_on_success: boolean;
  tags: string[];
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Credential Set Summary
 */
export interface CredentialSetSummary {
  id: string;
  name: string;
  description?: string;
  credentials: UnifiedCredentialSummary[];
  strategy: CredentialSetStrategy;
  stop_on_success: boolean;
  tags: string[];
  created_at: Date;
  updated_at: Date;
  usage_count?: number;
}

/**
 * Credential Set Input
 */
export interface CredentialSetInput {
  name: string;
  description?: string;
  credential_ids: string[];
  strategy?: CredentialSetStrategy;
  stop_on_success?: boolean;
  tags?: string[];
}

/**
 * Credential Set Update Input
 */
export interface CredentialSetUpdateInput {
  name?: string;
  description?: string;
  credential_ids?: string[];
  strategy?: CredentialSetStrategy;
  stop_on_success?: boolean;
  tags?: string[];
}

class CredentialService {
  private axiosInstance: AxiosInstance;

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: API_BASE_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add auth token interceptor
    this.axiosInstance.interceptors.request.use((config) => {
      const token = localStorage.getItem('auth_token');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    });

    // Add error interceptor
    this.axiosInstance.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response?.status === 401) {
          localStorage.removeItem('auth_token');
          window.location.href = '/login';
        }
        return Promise.reject(error);
      }
    );
  }

  // ============================================================================
  // Credential Operations
  // ============================================================================

  /**
   * List all credentials with optional filters
   */
  async listCredentials(filters?: CredentialFilters): Promise<CredentialListResponse> {
    const params = new URLSearchParams();
    if (filters?.protocol) params.append('protocol', filters.protocol);
    if (filters?.scope) params.append('scope', filters.scope);
    if (filters?.tags) params.append('tags', filters.tags.join(','));
    if (filters?.search) params.append('search', filters.search);
    if (filters?.page) params.append('page', filters.page.toString());
    if (filters?.limit) params.append('limit', filters.limit.toString());

    const response = await this.axiosInstance.get<{
      success: boolean;
      data: UnifiedCredentialSummary[];
      count?: number;
      pagination?: {
        total: number;
        page: number;
        limit: number;
        totalPages: number;
      };
    }>(`/credentials?${params.toString()}`);

    const data = response.data.data ?? [];
    const pg = response.data.pagination;
    const total = pg?.total ?? response.data.count ?? data.length;
    const limit = pg?.limit ?? filters?.limit ?? data.length;
    return {
      data,
      total,
      page: pg?.page ?? filters?.page ?? 1,
      limit,
      total_pages: pg?.totalPages ?? (limit > 0 ? Math.ceil(total / limit) : 1),
    };
  }

  /**
   * Get a single credential by ID
   */
  async getCredential(id: string): Promise<UnifiedCredential> {
    const response = await this.axiosInstance.get<{
      success: boolean;
      data: UnifiedCredential;
    }>(`/credentials/${id}`);
    return response.data.data;
  }

  /**
   * Create a new credential
   */
  async createCredential(input: UnifiedCredentialInput): Promise<UnifiedCredential> {
    const response = await this.axiosInstance.post<{
      success: boolean;
      data: UnifiedCredential;
    }>('/credentials', input);
    return response.data.data;
  }

  /**
   * Update an existing credential
   */
  async updateCredential(
    id: string,
    input: UnifiedCredentialUpdateInput
  ): Promise<UnifiedCredential> {
    const response = await this.axiosInstance.put<{
      success: boolean;
      data: UnifiedCredential;
    }>(`/credentials/${id}`, input);
    return response.data.data;
  }

  /**
   * Delete a credential
   */
  async deleteCredential(id: string): Promise<void> {
    await this.axiosInstance.delete(`/credentials/${id}`);
  }

  /**
   * Validate a credential
   */
  async validateCredential(id: string): Promise<CredentialValidationResult> {
    const response = await this.axiosInstance.post<{
      success: boolean;
      data: CredentialValidationResult;
    }>(`/credentials/${id}/validate`);
    return response.data.data;
  }

  // ============================================================================
  // Credential Matching and Ranking
  // ============================================================================

  /**
   * Match credentials based on context (returns best match)
   */
  async matchCredentials(context: CredentialMatchContext): Promise<CredentialMatchResult | null> {
    const response = await this.axiosInstance.post<{
      success: boolean;
      data: CredentialMatchResult | null;
    }>('/credentials/match', context);
    return response.data.data;
  }

  /**
   * Rank credentials based on context (returns all matches sorted by score)
   */
  async rankCredentials(context: CredentialMatchContext): Promise<CredentialMatchResult[]> {
    const response = await this.axiosInstance.post<{
      success: boolean;
      data: CredentialMatchResult[];
    }>('/credentials/rank', context);
    return response.data.data;
  }

  // ============================================================================
  // Credential Set Operations
  // ============================================================================

  /**
   * Create a new credential set
   */
  async createCredentialSet(input: CredentialSetInput): Promise<CredentialSet> {
    const response = await this.axiosInstance.post<{
      success: boolean;
      data: CredentialSet;
    }>('/credential-sets', input);
    return response.data.data;
  }

  /**
   * List all credential sets
   */
  async getCredentialSets(): Promise<CredentialSetSummary[]> {
    const response = await this.axiosInstance.get<{
      success: boolean;
      data: CredentialSetSummary[];
    }>('/credential-sets');
    return response.data.data;
  }

  /**
   * Get a single credential set by ID
   */
  async getCredentialSet(id: string): Promise<CredentialSetSummary> {
    const response = await this.axiosInstance.get<{
      success: boolean;
      data: CredentialSetSummary;
    }>(`/credential-sets/${id}`);
    return response.data.data;
  }

  /**
   * Update an existing credential set
   */
  async updateCredentialSet(
    id: string,
    input: CredentialSetUpdateInput
  ): Promise<CredentialSet> {
    const response = await this.axiosInstance.put<{
      success: boolean;
      data: CredentialSet;
    }>(`/credential-sets/${id}`, input);
    return response.data.data;
  }

  /**
   * Delete a credential set
   */
  async deleteCredentialSet(id: string): Promise<void> {
    await this.axiosInstance.delete(`/credential-sets/${id}`);
  }

  /**
   * Select credentials from a set based on context
   */
  async selectCredentials(
    setId: string,
    context: CredentialMatchContext,
    strategy?: CredentialSetStrategy
  ): Promise<UnifiedCredential[]> {
    const response = await this.axiosInstance.post<{
      success: boolean;
      data: UnifiedCredential[];
    }>(`/credential-sets/${setId}/select`, {
      context,
      strategy,
    });
    return response.data.data;
  }
}

export const credentialService = new CredentialService();
export default credentialService;
