/**
 * E2E Test API Client
 *
 * HTTP client for interacting with the CMDB API during E2E tests.
 * Unwraps the underscore-prefixed envelope (_success, _data, _pagination).
 */

import axios, { AxiosInstance } from 'axios';

export interface ApiClientConfig {
  baseURL: string;
  timeout?: number;
}

export class ApiClient {
  private client: AxiosInstance;

  constructor(config: ApiClientConfig) {
    this.client = axios.create({
      baseURL: config.baseURL,
      timeout: config.timeout || 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  async healthCheck(): Promise<{ status: string }> {
    const response = await this.client.get('/health');
    return response.data as { status: string };
  }

  // ---------------------------------------------------------------------------
  // CI CRUD
  // ---------------------------------------------------------------------------

  /** POST /api/v1/cis — returns raw recordToCI shape (_id, _type, …). */
  async createCI(ci: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.client.post('/api/v1/cis', ci);
    return response.data._data as Record<string, unknown>;
  }

  /** GET /api/v1/cis/:id — returns convertNeo4jTypes shape (id, type, …). */
  async getCI(id: string): Promise<Record<string, unknown>> {
    const response = await this.client.get(`/api/v1/cis/${id}`);
    return response.data._data as Record<string, unknown>;
  }

  /** PUT /api/v1/cis/:id — body uses non-underscore keys; returns recordToCI. */
  async updateCI(id: string, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.client.put(`/api/v1/cis/${id}`, updates);
    return response.data._data as Record<string, unknown>;
  }

  /** DELETE /api/v1/cis/:id — 204 No Content. */
  async deleteCI(id: string): Promise<void> {
    await this.client.delete(`/api/v1/cis/${id}`);
  }

  /** GET /api/v1/cis — returns { data: CI[], total }. */
  async listCIs(
    filters?: Record<string, unknown>
  ): Promise<{ data: Record<string, unknown>[]; total: number }> {
    const response = await this.client.get('/api/v1/cis', { params: filters });
    return {
      data: response.data._data as Record<string, unknown>[],
      total: (response.data._pagination as Record<string, unknown>).total as number,
    };
  }

  /** POST /api/v1/cis/search — body { query }; returns _data array. */
  async searchCIs(query: string): Promise<Record<string, unknown>[]> {
    const response = await this.client.post('/api/v1/cis/search', { query });
    return response.data._data as Record<string, unknown>[];
  }

  // ---------------------------------------------------------------------------
  // Relationships
  // ---------------------------------------------------------------------------

  /** POST /api/v1/relationships — returns _data. */
  async createRelationship(rel: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.client.post('/api/v1/relationships', rel);
    return response.data._data as Record<string, unknown>;
  }

  /** GET /api/v1/cis/:id/relationships — returns _data array. */
  async getRelationships(ciId: string): Promise<Record<string, unknown>[]> {
    const response = await this.client.get(`/api/v1/cis/${ciId}/relationships`);
    return response.data._data as Record<string, unknown>[];
  }

  // ---------------------------------------------------------------------------
  // Impact Analysis
  // ---------------------------------------------------------------------------

  /** GET /api/v1/cis/:id/impact?depth= — returns _data object. */
  async getImpactAnalysis(
    ciId: string,
    depth?: number
  ): Promise<Record<string, unknown>> {
    const response = await this.client.get(`/api/v1/cis/${ciId}/impact`, {
      params: { depth },
    });
    return response.data._data as Record<string, unknown>;
  }
}

/**
 * Create an API client for E2E tests.
 */
export function createApiClient(config?: Partial<ApiClientConfig>): ApiClient {
  return new ApiClient({
    baseURL: config?.baseURL || 'http://localhost:3001',
    timeout: config?.timeout || 30000,
  });
}
