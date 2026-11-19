// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import axios from 'axios';
import { attachSession } from '../lib/session';
import type { AffectedBusinessService } from '../types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';

export interface CI {
  id: string;
  name: string;
  type: CIType;
  status: CIStatus;
  environment: Environment;
  description?: string;
  attributes: Record<string, any>;
  metadata?: Record<string, any>;
  /**
   * Normalized by the server at read time (services/ci-normalized-fields.ts): a stored top-level value exactly as
   * stored (`ip_address` may be an array of addresses), else a trimmed string of at most 256 characters from the
   * metadata bag, else null.
   */
  owner?: string | null;
  provider?: string | null;
  ip_address?: string | string[] | null;
  tier?: string | null;
  /** Derived by the server from open incidents (services/ci-health.ts); null: the signal is unavailable. */
  health?: CIHealth | null;
  tags: string[];
  discovered_by?: string;
  last_discovered?: string;
  confidence_score?: number;
  created_at: string;
  updated_at: string;
}

export type CIType =
  | 'server'
  | 'virtual-machine'
  | 'container'
  | 'application'
  | 'service'
  | 'database'
  | 'network-device'
  | 'storage'
  | 'load-balancer'
  | 'cloud-resource';

/** Derived CI health (BW1): critical = open incident of priority 1 or 2, degraded = priority 3 to 5, healthy = none. */
export type CIHealth = 'healthy' | 'degraded' | 'critical';

export type CIStatus = 'active' | 'inactive' | 'maintenance' | 'decommissioned';

export type Environment = 'production' | 'staging' | 'development' | 'test';

export interface CIRelationship {
  id: string;
  type: RelationshipType;
  source_ci_id: string;
  target_ci_id: string;
  source_ci?: CI;
  target_ci?: CI;
  properties?: Record<string, any>;
  created_at: string;
}

export type RelationshipType =
  | 'DEPENDS_ON'
  | 'HOSTS'
  | 'CONNECTS_TO'
  | 'USES'
  | 'OWNED_BY'
  | 'PART_OF'
  | 'MONITORS';

export interface CIListParams {
  page?: number;
  limit?: number;
  type?: CIType;
  status?: CIStatus;
  environment?: Environment;
  search?: string;
  tags?: string[];
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
}

export interface CIListResponse {
  data: CI[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

export interface DashboardStats {
  total_cis: number;
  by_type: Record<CIType, number>;
  by_status: Record<CIStatus, number>;
  by_environment: Record<Environment, number>;
  recent_discoveries: CI[];
  /** Percentage of CIs with health `healthy`; null: unavailable (BW1), never a placeholder 0. */
  health_score: number | null;
  /** CIs by derived health state; null when the signal is unavailable. Optional: older servers omit it. */
  ci_health?: { healthy: number; degraded: number; critical: number; total: number } | null;
  /** Relationships with at least one endpoint that is a critical CI (bsm_business_criticality tier_1 or tier_2). */
  critical_relationships: number;
}

export interface ImpactAnalysis {
  ci: CI;
  upstream: CI[];
  downstream: CI[];
  /** GET /cis/:id/impact: min(upstream + downstream count / 10, 1), a 0-1 ratio. Multiply by 100 to show a percentage. */
  impact_score: number;
  affected_environments: Environment[];
  /** HAP-1927 BW11: business services mapped to this CI or its downstream CIs, with derived cost per hour. */
  affected_business_services?: AffectedBusinessService[];
  /** annual revenue / 8760 summed over the affected services that have revenue; null (listed in `unavailable`) when none does. */
  cost_per_hour?: number | null;
  cost_per_hour_services_priced?: number;
  /** Fields that have no backing data on this response. */
  unavailable?: string[];
}

export interface CreateCIRequest {
  name: string;
  type: CIType;
  status: CIStatus;
  environment: Environment;
  description?: string;
  attributes?: Record<string, any>;
  tags?: string[];
}

export interface UpdateCIRequest extends Partial<CreateCIRequest> {}

class CIService {
  private axiosInstance = axios.create({
    baseURL: API_BASE_URL,
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  constructor() {
    // Bearer from memory; a 401 renews the session once from the refresh cookie (HAP-1211 H2)
    attachSession(this.axiosInstance);
  }

  async getCIs(params?: CIListParams): Promise<CIListResponse> {
    const response = await this.axiosInstance.get<{
      success: boolean;
      data: CI[];
      pagination: {
        total: number;
        page: number;
        limit: number;
        totalPages: number;
      };
    }>('/cis', { params });

    return {
      data: response.data.data,
      total: response.data.pagination.total,
      page: response.data.pagination.page,
      limit: response.data.pagination.limit,
      total_pages: response.data.pagination.totalPages,
    };
  }

  async getCIById(id: string): Promise<CI> {
    const response = await this.axiosInstance.get<{
      success: boolean;
      data: CI;
    }>(`/cis/${id}`);
    return response.data.data;
  }

  async createCI(data: CreateCIRequest): Promise<CI> {
    const response = await this.axiosInstance.post<{
      success: boolean;
      data: CI;
    }>('/cis', data);
    return response.data.data;
  }

  async updateCI(id: string, data: UpdateCIRequest): Promise<CI> {
    const response = await this.axiosInstance.put<{
      success: boolean;
      data: CI;
    }>(`/cis/${id}`, data);
    return response.data.data;
  }

  async deleteCI(id: string): Promise<void> {
    await this.axiosInstance.delete(`/cis/${id}`);
  }

  async getCIRelationships(id: string, depth: number = 1): Promise<CIRelationship[]> {
    const response = await this.axiosInstance.get<{
      success: boolean;
      data: CIRelationship[];
    }>(`/cis/${id}/relationships`, {
      params: { depth }
    });
    return response.data.data;
  }

  async getImpactAnalysis(id: string): Promise<ImpactAnalysis> {
    const response = await this.axiosInstance.get<{
      success: boolean;
      data: ImpactAnalysis;
    }>(`/cis/${id}/impact`);
    return response.data.data;
  }

  async getDashboardStats(): Promise<DashboardStats> {
    const response = await this.axiosInstance.get<DashboardStats>('/analytics/dashboard');
    return response.data;
  }

  async searchCIs(query: string, filters?: Partial<CIListParams>): Promise<CI[]> {
    const response = await this.axiosInstance.get<CIListResponse>('/cis', {
      params: { search: query, ...filters, limit: 50 },
    });
    return response.data.data;
  }

  async getCIsByType(type: CIType, limit = 100): Promise<CI[]> {
    const response = await this.axiosInstance.get<CIListResponse>('/cis', {
      params: { type, limit },
    });
    return response.data.data;
  }

  async getCIsByStatus(status: CIStatus, limit = 100): Promise<CI[]> {
    const response = await this.axiosInstance.get<CIListResponse>('/cis', {
      params: { status, limit },
    });
    return response.data.data;
  }

  async getCIsByEnvironment(environment: Environment, limit = 100): Promise<CI[]> {
    const response = await this.axiosInstance.get<CIListResponse>('/cis', {
      params: { environment, limit },
    });
    return response.data.data;
  }

  async getCIsByTags(tags: string[], limit = 100): Promise<CI[]> {
    const response = await this.axiosInstance.get<CIListResponse>('/cis', {
      params: { tags, limit },
    });
    return response.data.data;
  }

  async getCIAuditHistory(id: string): Promise<AuditLogEntry[]> {
    const response = await this.axiosInstance.get<{
      success: boolean;
      data: AuditLogEntry[];
    }>(`/cis/${id}/audit`);
    return response.data.data;
  }
}

export interface AuditLogEntry {
  id: string;
  entity_type: 'CI' | 'RELATIONSHIP';
  entity_id: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'RELATIONSHIP_ADD' | 'RELATIONSHIP_REMOVE' | 'DISCOVERY_UPDATE';
  actor: string;
  actor_type: 'user' | 'system' | 'discovery';
  changes: AuditChange[];
  metadata?: Record<string, any>;
  timestamp: string;
  ip_address?: string;
  user_agent?: string;
}

export interface AuditChange {
  field: string;
  old_value: any;
  new_value: any;
  field_type?: string;
}

export const ciService = new CIService();
export default ciService;
