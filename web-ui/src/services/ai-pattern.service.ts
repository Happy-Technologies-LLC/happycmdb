// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { apiClient as api } from '../lib/api-client';

/** Standard {success, data} envelope every AI pattern endpoint responds with. */
interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
  message?: string;
}

/** Result shape shared by every pattern workflow transition. */
interface WorkflowResult {
  success: boolean;
  error?: string;
}

export interface AIPattern {
  patternId: string;
  name: string;
  category: string;
  description?: string;
  detectionCode: string;
  discoveryCode: string;
  author: string;
  confidenceScore: number;
  status: 'draft' | 'review' | 'approved' | 'active' | 'deprecated';
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  usageCount: number;
  successCount: number;
  failureCount: number;
  avgExecutionTimeMs?: number;
  learnedFromSessions?: string[];
  testCases?: PatternTestCase[];
}

export interface PatternTestCase {
  name: string;
  input: unknown;
  expectedMatch: boolean;
  expectedConfidence?: number;
}

export interface ToolCall {
  toolName: string;
  input: unknown;
  output: unknown;
  success: boolean;
  executionTime: number;
  timestamp: string;
  error?: string;
}

export interface AIDiscoverySession {
  sessionId: string;
  targetHost: string;
  targetPort: number;
  status: 'running' | 'completed' | 'failed';
  toolCalls: ToolCall[];
  discoveredCIs: unknown[];
  confidenceScore?: number;
  estimatedCost?: number;
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  aiReasoning?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  aiModel: string;
  patternMatched?: string;
  errorMessage?: string;
  retryCount: number;
}

export interface PatternUsageMetrics {
  patternId: string;
  timestamp: string;
  executionTimeMs: number;
  success: boolean;
  confidenceScore?: number;
  errorMessage?: string;
  matchedHost?: string;
  matchedPort?: number;
}

export interface PatternAnalysisResult {
  isPattern: boolean;
  signature: {
    signatureHash: string;
    toolSequence: string[];
    serviceIndicators: string[];
    confidenceScore: number;
    sessionCount: number;
    sessions: string[];
  } | null;
  candidate: {
    suggestedName: string;
    suggestedCategory: string;
    commonElements: {
      ports: number[];
      headers: string[];
      endpoints: string[];
      serviceNames: string[];
    };
    readyForCompilation: boolean;
  } | null;
}

export interface PatternValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  testResults: Array<{
    testName: string;
    passed: boolean;
    error?: string;
  }>;
}

export interface CostAnalytics {
  totalCost: number;
  totalSessions: number;
  avgCostPerSession: number;
  costByModel: Array<{
    aiModel: string;
    cost: number;
    sessions: number;
  }>;
  costByDay: Array<{
    date: string;
    cost: number;
    sessions: number;
  }>;
  savingsFromPatterns: {
    totalSaved: number;
    percentSaved: number;
    patternHits: number;
    aiDiscoveries: number;
  };
}

export interface PatternHistoryEntry {
  action: 'submit' | 'approve' | 'reject' | 'activate' | 'deactivate';
  performedBy: string;
  timestamp: string;
  comment?: string;
}

export interface PatternFilters {
  status?: string[];
  category?: string;
  isActive?: boolean;
  minConfidence?: number;
  minUsage?: number;
  search?: string;
}

export interface SessionFilters {
  status?: string[];
  aiModel?: string;
  dateFrom?: string;
  dateTo?: string;
  minCost?: number;
  maxCost?: number;
  search?: string;
}

/**
 * Every workflow-transition endpoint (submit/approve/reject/activate/
 * deactivate) answers invalid transitions with a 404/409 HTTP status rather
 * than a 200, so axios rejects the promise. The controller still nests the
 * full WorkflowResult under the error envelope's `data` field, so recover it
 * here and hand callers back the same resolved {success, error} shape they'd
 * have gotten on a 200 - existing call sites branch on `.success`, not on
 * whether the promise rejected.
 */
function isAxiosErrorWithResponse(err: unknown): err is { response?: { data?: unknown } } {
  return typeof err === 'object' && err !== null && 'response' in err;
}

function unwrapWorkflowError<T extends WorkflowResult>(err: unknown, fallback: string): T {
  const rawData = isAxiosErrorWithResponse(err) ? err.response?.data : undefined;
  // axios types response bodies as `any`; assert our own known
  // {success,data,message} envelope contract rather than leaving it untyped.
  const envelope = rawData as Partial<ApiResponse<T>> | undefined;
  const workflowResult = envelope?.data;
  if (workflowResult && typeof workflowResult === 'object' && 'success' in workflowResult) {
    return workflowResult as T;
  }
  return { success: false, error: envelope?.message || fallback } as T;
}

class AIPatternService {
  // Pattern Management
  async listPatterns(filters?: PatternFilters): Promise<AIPattern[]> {
    const response = await api.get<ApiResponse<AIPattern[]>>('/ai/patterns', { params: filters });
    return response.data;
  }

  async getPattern(patternId: string): Promise<AIPattern> {
    const response = await api.get<ApiResponse<AIPattern>>(`/ai/patterns/${patternId}`);
    return response.data;
  }

  async deletePattern(patternId: string): Promise<void> {
    await api.delete(`/ai/patterns/${patternId}`);
  }

  // Pattern Workflow (actors are derived server-side from the authenticated
  // user - never accepted from the client)
  async submitForReview(patternId: string, notes?: string): Promise<
    WorkflowResult & { validation?: PatternValidationResult }
  > {
    try {
      const response = await api.post<
        ApiResponse<WorkflowResult & { validation?: PatternValidationResult }>
      >(`/ai/patterns/${patternId}/submit`, { notes });
      return response.data;
    } catch (err) {
      return unwrapWorkflowError(err, 'Failed to submit pattern for review');
    }
  }

  async approvePattern(patternId: string, notes?: string): Promise<WorkflowResult> {
    try {
      const response = await api.post<ApiResponse<WorkflowResult>>(
        `/ai/patterns/${patternId}/approve`,
        { notes }
      );
      return response.data;
    } catch (err) {
      return unwrapWorkflowError(err, 'Failed to approve pattern');
    }
  }

  async rejectPattern(patternId: string, reason: string): Promise<WorkflowResult> {
    try {
      const response = await api.post<ApiResponse<WorkflowResult>>(
        `/ai/patterns/${patternId}/reject`,
        { reason }
      );
      return response.data;
    } catch (err) {
      return unwrapWorkflowError(err, 'Failed to reject pattern');
    }
  }

  async activatePattern(patternId: string): Promise<WorkflowResult> {
    try {
      const response = await api.post<ApiResponse<WorkflowResult>>(
        `/ai/patterns/${patternId}/activate`
      );
      return response.data;
    } catch (err) {
      return unwrapWorkflowError(err, 'Failed to activate pattern');
    }
  }

  async deactivatePattern(patternId: string, reason?: string): Promise<WorkflowResult> {
    try {
      const response = await api.post<ApiResponse<WorkflowResult>>(
        `/ai/patterns/${patternId}/deactivate`,
        { reason }
      );
      return response.data;
    } catch (err) {
      return unwrapWorkflowError(err, 'Failed to deactivate pattern');
    }
  }

  // Pattern Validation
  async validatePattern(patternId: string): Promise<PatternValidationResult> {
    const response = await api.post<ApiResponse<PatternValidationResult>>(
      `/ai/patterns/${patternId}/validate`
    );
    return response.data;
  }

  // Discovery Sessions
  async listSessions(filters?: SessionFilters): Promise<AIDiscoverySession[]> {
    const response = await api.get<ApiResponse<AIDiscoverySession[]>>('/ai/sessions', {
      params: filters,
    });
    return response.data;
  }

  async getSession(sessionId: string): Promise<AIDiscoverySession> {
    const response = await api.get<ApiResponse<AIDiscoverySession>>(`/ai/sessions/${sessionId}`);
    return response.data;
  }

  // Pattern Analysis
  async analyzeSession(sessionId: string): Promise<PatternAnalysisResult> {
    const response = await api.post<ApiResponse<PatternAnalysisResult>>(
      `/ai/sessions/${sessionId}/analyze`
    );
    return response.data;
  }

  async compileAndSubmitPatterns(): Promise<{
    compiled: number;
    submitted: number;
    errors: string[];
  }> {
    const response = await api.post<
      ApiResponse<{ compiled: number; submitted: number; errors: string[] }>
    >('/ai/patterns/compile');
    return response.data;
  }

  // Pattern Usage Metrics
  async getPatternUsage(patternId: string, days?: number): Promise<PatternUsageMetrics[]> {
    const response = await api.get<ApiResponse<PatternUsageMetrics[]>>(
      `/ai/patterns/${patternId}/usage`,
      { params: { days } }
    );
    return response.data;
  }

  // Cost Analytics
  async getCostAnalytics(dateFrom?: string, dateTo?: string): Promise<CostAnalytics> {
    const response = await api.get<ApiResponse<CostAnalytics>>('/ai/analytics/cost', {
      params: { dateFrom, dateTo },
    });
    return response.data;
  }

  // Pattern Learning Statistics
  async getLearningStats(): Promise<{
    totalPatterns: number;
    activePatterns: number;
    pendingReview: number;
    autoApproved: number;
    manualApproved: number;
    totalSessions: number;
    avgConfidence: number;
  }> {
    const response = await api.get<
      ApiResponse<{
        totalPatterns: number;
        activePatterns: number;
        pendingReview: number;
        autoApproved: number;
        manualApproved: number;
        totalSessions: number;
        avgConfidence: number;
      }>
    >('/ai/analytics/learning');
    return response.data;
  }

  // Pattern History
  async getPatternHistory(patternId: string): Promise<PatternHistoryEntry[]> {
    const response = await api.get<ApiResponse<PatternHistoryEntry[]>>(
      `/ai/patterns/${patternId}/history`
    );
    return response.data;
  }
}

export const aiPatternService = new AIPatternService();
