// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

export interface CI {
  id: string;
  name: string;
  type: CIType;
  status: CIStatus;
  environment: Environment;
  description?: string;
  attributes: Record<string, any>;
  metadata?: Record<string, any>;
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
  health_score: number;
  critical_relationships: number;
}

export interface ImpactAnalysis {
  ci: CI;
  upstream: CI[];
  downstream: CI[];
  impact_score: number;
  affected_environments: Environment[];
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
          // Handle unauthorized
          localStorage.removeItem('auth_token');
          window.location.href = '/login';
        }
        return Promise.reject(error);
      }
    );
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
