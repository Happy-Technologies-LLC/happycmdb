// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Pattern Analyzer
 * Analyzes AI discovery sessions to identify repeatable patterns
 */

import { AIDiscoverySession } from './types';
import { PatternStorageService } from './pattern-storage';
import { logger } from '@cmdb/common';
import { getPostgresClient } from '@cmdb/database';

export interface PatternSignature {
  signatureHash: string;
  toolSequence: string[];
  serviceIndicators: string[];
  confidenceScore: number;
  sessionCount: number;
  sessions: string[];
}

export interface PatternCandidate {
  signature: PatternSignature;
  suggestedName: string;
  suggestedCategory: string;
  commonElements: {
    ports: number[];
    headers: string[];
    endpoints: string[];
    serviceNames: string[];
  };
  readyForCompilation: boolean;
}

export class PatternAnalyzer {
  private patternStorage: PatternStorageService;
  private postgresClient = getPostgresClient();
  private readonly PATTERN_THRESHOLD = 3; // Min sessions to suggest pattern

  constructor(patternStorage?: PatternStorageService) {
    this.patternStorage = patternStorage || new PatternStorageService();
  }

  /**
   * Analyze a discovery session to see if it contributes to a pattern
   */
  async analyzeSession(session: AIDiscoverySession, organizationId?: string): Promise<{
    isPattern: boolean;
    signature: PatternSignature | null;
    candidate: PatternCandidate | null;
  }> {
    // Analysis can include other sessions in a candidate. Without a verified
    // tenant, it must never run the similarity query.
    if (!organizationId) throw new Error('Organization required for session analysis');
    try {
      // Only analyze successful sessions with high confidence
      if (
        session.status !== 'completed' ||
        !session.confidenceScore ||
        session.confidenceScore < 0.8 ||
        session.toolCalls.length < 2
      ) {
        logger.debug('Session not suitable for pattern analysis', {
          sessionId: session.sessionId,
          status: session.status,
          confidence: session.confidenceScore,
          toolCalls: session.toolCalls.length,
        });
        return { isPattern: false, signature: null, candidate: null };
      }

      // Generate signature for this session
      const signature = this.generateSignature(session);

      // Find similar sessions
      const similarSessions = await this.findSimilarSessions(signature, organizationId);

      logger.info('Pattern analysis', {
        sessionId: session.sessionId,
        signature: signature.signatureHash,
        similarCount: similarSessions.length,
      });

      // Check if we have enough similar sessions to suggest a pattern
      if (similarSessions.length >= this.PATTERN_THRESHOLD) {
        // Build pattern candidate
        const candidate = await this.buildPatternCandidate(
          signature,
          similarSessions
        );

        logger.info('Pattern candidate identified', {
          signature: signature.signatureHash,
          name: candidate.suggestedName,
          sessionCount: similarSessions.length,
        });

        return { isPattern: true, signature, candidate };
      }

      return { isPattern: false, signature, candidate: null };
    } catch (error) {
      logger.error('Pattern analysis failed', {
        sessionId: session.sessionId,
        error,
      });
      return { isPattern: false, signature: null, candidate: null };
    }
  }

  /**
   * Generate signature for a discovery session
   */
  private generateSignature(session: AIDiscoverySession): PatternSignature {
    // Extract tool sequence
    const toolSequence = session.toolCalls
      .filter(tc => tc.success)
      .map(tc => tc.toolName);

    // Extract service indicators
    const indicators: string[] = [];

    // Look for common indicators in tool calls
    for (const toolCall of session.toolCalls) {
      if (!toolCall.success || !toolCall.output) continue;

      const output = toolCall.output;

      // HTTP headers
      if (output.headers) {
        Object.keys(output.headers).forEach(header => {
          if (
            ['server', 'x-powered-by', 'x-application-context'].includes(
              header.toLowerCase()
            )
          ) {
            indicators.push(`header:${header.toLowerCase()}`);
          }
        });
      }

      // Ports
      if (output.port || output.openPorts) {
        const ports = output.openPorts || [output.port];
        ports.forEach((port: number) => indicators.push(`port:${port}`));
      }

      // Endpoints
      if (output.endpoints) {
        output.endpoints.forEach((endpoint: string) => {
          indicators.push(`endpoint:${endpoint}`);
        });
      }

      // Service names
      if (output.service || output.services) {
        const services = Array.isArray(output.services)
          ? output.services
          : [output.services || output.service];
        services.forEach((svc: any) => {
          const name = typeof svc === 'string' ? svc : svc.service;
          if (name) indicators.push(`service:${name}`);
        });
      }
    }

    // Create hash from tool sequence + indicators
    const signatureString = JSON.stringify({
      tools: toolSequence,
      indicators: indicators.sort(),
    });

    const signatureHash = this.hashString(signatureString);

    return {
      signatureHash,
      toolSequence,
      serviceIndicators: indicators,
      confidenceScore: session.confidenceScore || 0,
      sessionCount: 1,
      sessions: [session.sessionId],
    };
  }

  /**
   * Find sessions with similar signatures
   */
  private async findSimilarSessions(
    signature: PatternSignature,
    organizationId: string
  ): Promise<AIDiscoverySession[]> {
    const client = await this.postgresClient.getClient();

    try {
      // Query for completed sessions with similar characteristics
      const result = await client.query(
        `SELECT
          id, session_id, target_host, target_port,
          scan_result, status, started_at, completed_at,
          duration_ms, ai_model, total_tokens, prompt_tokens,
          completion_tokens, estimated_cost, discovered_cis,
          confidence_score, tool_calls, ai_reasoning,
          pattern_matched, error_message, retry_count,
          created_at
        FROM ai_discovery_sessions
        WHERE status = 'completed'
          AND organization_id = $1
          AND confidence_score >= 0.8
          AND jsonb_array_length(tool_calls) >= 2
        ORDER BY started_at DESC
        LIMIT 100`,
        [organizationId]
      );

      const similarSessions: AIDiscoverySession[] = [];

      // Analyze each session for similarity
      for (const row of result.rows) {
        const session = this.rowToSession(row);
        const sessionSig = this.generateSignature(session);

        // Check similarity
        if (this.signaturesAreSimilar(signature, sessionSig)) {
          similarSessions.push(session);
        }
      }

      logger.debug('Found similar sessions', {
        total: result.rows.length,
        similar: similarSessions.length,
      });

      return similarSessions;
    } finally {
      client.release();
    }
  }

  /**
   * Check if two signatures are similar
   */
  private signaturesAreSimilar(
    sig1: PatternSignature,
    sig2: PatternSignature
  ): boolean {
    // Same hash = exact match
    if (sig1.signatureHash === sig2.signatureHash) {
      return true;
    }

    // Check tool sequence similarity (at least 70% match)
    const toolSimilarity = this.calculateSequenceSimilarity(
      sig1.toolSequence,
      sig2.toolSequence
    );

    // Check indicator overlap (at least 50% match)
    const indicatorSimilarity = this.calculateSetSimilarity(
      sig1.serviceIndicators,
      sig2.serviceIndicators
    );

    return toolSimilarity >= 0.7 && indicatorSimilarity >= 0.5;
  }

  /**
   * Calculate similarity between two sequences (0-1)
   */
  private calculateSequenceSimilarity(seq1: string[], seq2: string[]): number {
    if (seq1.length === 0 && seq2.length === 0) return 1.0;
    if (seq1.length === 0 || seq2.length === 0) return 0.0;

    const maxLength = Math.max(seq1.length, seq2.length);
    let matches = 0;

    for (let i = 0; i < Math.min(seq1.length, seq2.length); i++) {
      if (seq1[i] === seq2[i]) matches++;
    }

    return matches / maxLength;
  }

  /**
   * Calculate similarity between two sets (0-1)
   */
  private calculateSetSimilarity(set1: string[], set2: string[]): number {
    if (set1.length === 0 && set2.length === 0) return 1.0;
    if (set1.length === 0 || set2.length === 0) return 0.0;

    const s1 = new Set(set1);
    const s2 = new Set(set2);

    const intersection = new Set([...s1].filter(x => s2.has(x)));
    const union = new Set([...s1, ...s2]);

    return intersection.size / union.size;
  }

  /**
   * Build pattern candidate from similar sessions
   */
  private async buildPatternCandidate(
    signature: PatternSignature,
    sessions: AIDiscoverySession[]
  ): Promise<PatternCandidate> {
    // Extract common elements across sessions
    const commonPorts = this.extractCommonPorts(sessions);
    const commonHeaders = this.extractCommonHeaders(sessions);
    const commonEndpoints = this.extractCommonEndpoints(sessions);
    const commonServiceNames = this.extractCommonServiceNames(sessions);

    // Suggest name and category based on common elements
    const suggestedName = this.suggestPatternName(
      commonServiceNames,
      commonHeaders,
      commonEndpoints
    );

    const suggestedCategory = this.suggestCategory(
      commonServiceNames,
      commonPorts
    );

    return {
      signature: {
        ...signature,
        sessionCount: sessions.length,
        sessions: sessions.map(s => s.sessionId),
      },
      suggestedName,
      suggestedCategory,
      commonElements: {
        ports: commonPorts,
        headers: commonHeaders,
        endpoints: commonEndpoints,
        serviceNames: commonServiceNames,
      },
      readyForCompilation: sessions.length >= this.PATTERN_THRESHOLD,
    };
  }

  /**
   * Extract common ports from sessions
   */
  private extractCommonPorts(sessions: AIDiscoverySession[]): number[] {
    const portCounts = new Map<number, number>();

    for (const session of sessions) {
      portCounts.set(
        session.targetPort,
        (portCounts.get(session.targetPort) || 0) + 1
      );
    }

    // Return ports that appear in >50% of sessions
    const threshold = sessions.length * 0.5;
    return Array.from(portCounts.entries())
      .filter(([_, count]) => count >= threshold)
      .map(([port, _]) => port);
  }

  /**
   * Extract common headers from sessions
   */
  private extractCommonHeaders(sessions: AIDiscoverySession[]): string[] {
    const headerCounts = new Map<string, number>();

    for (const session of sessions) {
      const indicators = this.generateSignature(session).serviceIndicators;
      indicators
        .filter(i => i.startsWith('header:'))
        .forEach(header => {
          headerCounts.set(header, (headerCounts.get(header) || 0) + 1);
        });
    }

    const threshold = sessions.length * 0.5;
    return Array.from(headerCounts.entries())
      .filter(([_, count]) => count >= threshold)
      .map(([header, _]) => header.replace('header:', ''));
  }

  /**
   * Extract common endpoints from sessions
   */
  private extractCommonEndpoints(sessions: AIDiscoverySession[]): string[] {
    const endpointCounts = new Map<string, number>();

    for (const session of sessions) {
      const indicators = this.generateSignature(session).serviceIndicators;
      indicators
        .filter(i => i.startsWith('endpoint:'))
        .forEach(endpoint => {
          endpointCounts.set(
            endpoint,
            (endpointCounts.get(endpoint) || 0) + 1
          );
        });
    }

    const threshold = sessions.length * 0.5;
    return Array.from(endpointCounts.entries())
      .filter(([_, count]) => count >= threshold)
      .map(([endpoint, _]) => endpoint.replace('endpoint:', ''));
  }

  /**
   * Extract common service names from sessions
   */
  private extractCommonServiceNames(sessions: AIDiscoverySession[]): string[] {
    const serviceCounts = new Map<string, number>();

    for (const session of sessions) {
      const indicators = this.generateSignature(session).serviceIndicators;
      indicators
        .filter(i => i.startsWith('service:'))
        .forEach(service => {
          serviceCounts.set(
            service,
            (serviceCounts.get(service) || 0) + 1
          );
        });
    }

    const threshold = sessions.length * 0.5;
    return Array.from(serviceCounts.entries())
      .filter(([_, count]) => count >= threshold)
      .map(([service, _]) => service.replace('service:', ''));
  }

  /**
   * Suggest pattern name from common elements
   */
  private suggestPatternName(
    serviceNames: string[],
    headers: string[],
    endpoints: string[]
  ): string {
    // Try service names first
    if (serviceNames.length > 0) {
      return serviceNames[0]
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }

    // Try headers
    if (headers.length > 0) {
      const header = headers[0];
      if (header.includes('spring')) return 'Spring Application';
      if (header.includes('express')) return 'Express Application';
      if (header.includes('nginx')) return 'Nginx Server';
    }

    // Try endpoints
    if (endpoints.length > 0) {
      const endpoint = endpoints[0];
      if (endpoint.includes('actuator')) return 'Spring Boot Application';
      if (endpoint.includes('health')) return 'Health Check Service';
    }

    return 'Unknown Pattern';
  }

  /**
   * Suggest category from common elements
   */
  private suggestCategory(
    serviceNames: string[],
    ports: number[]
  ): string {
    // Check service names
    const services = serviceNames.join(' ').toLowerCase();
    if (services.includes('postgres')) return 'databases';
    if (services.includes('mongo')) return 'databases';
    if (services.includes('redis')) return 'caching';
    if (services.includes('nginx')) return 'web-servers';
    if (services.includes('docker')) return 'container-platforms';
    if (services.includes('elastic')) return 'search-engines';
    if (services.includes('rabbit') || services.includes('kafka'))
      return 'message-queues';

    // Check ports
    if (ports.includes(5432)) return 'databases'; // PostgreSQL
    if (ports.includes(27017)) return 'databases'; // MongoDB
    if (ports.includes(6379)) return 'caching'; // Redis
    if (ports.includes(80) || ports.includes(443)) return 'web-servers';
    if (ports.includes(9200)) return 'search-engines'; // Elasticsearch
    if (ports.includes(5672)) return 'message-queues'; // RabbitMQ

    // Check for framework indicators
    if (services.includes('spring')) return 'java-frameworks';
    if (services.includes('express') || services.includes('node'))
      return 'nodejs-frameworks';

    return 'applications';
  }

  /**
   * Get all pattern candidates ready for compilation
   */
  async getPatternCandidates(): Promise<PatternCandidate[]> {
    const client = await this.postgresClient.getClient();

    try {
      // Get all completed sessions
      const result = await client.query(
        `SELECT
          id, session_id, target_host, target_port,
          scan_result, status, started_at, completed_at,
          duration_ms, ai_model, total_tokens, prompt_tokens,
          completion_tokens, estimated_cost, discovered_cis,
          confidence_score, tool_calls, ai_reasoning,
          pattern_matched, error_message, retry_count,
          created_at
        FROM ai_discovery_sessions
        WHERE status = 'completed'
          AND confidence_score >= 0.8
          AND pattern_matched IS NULL
        ORDER BY started_at DESC
        LIMIT 200`
      );

      const sessions = result.rows.map(row => this.rowToSession(row));

      // Group sessions by signature
      const signatureGroups = new Map<string, AIDiscoverySession[]>();

      for (const session of sessions) {
        const signature = this.generateSignature(session);
        const existing = signatureGroups.get(signature.signatureHash) || [];
        signatureGroups.set(signature.signatureHash, [...existing, session]);
      }

      // Build candidates for groups with enough sessions
      const candidates: PatternCandidate[] = [];

      for (const [hash, groupSessions] of signatureGroups.entries()) {
        if (groupSessions.length >= this.PATTERN_THRESHOLD) {
          const signature = this.generateSignature(groupSessions[0]);
          const candidate = await this.buildPatternCandidate(
            signature,
            groupSessions
          );
          candidates.push(candidate);
        }
      }

      logger.info('Found pattern candidates', {
        totalSessions: sessions.length,
        signatureGroups: signatureGroups.size,
        candidates: candidates.length,
      });

      return candidates;
    } finally {
      client.release();
    }
  }

  /**
   * Simple hash function for strings
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Convert database row to AIDiscoverySession
   */
  private rowToSession(row: any): AIDiscoverySession {
    return {
      id: row.id,
      sessionId: row.session_id,
      targetHost: row.target_host,
      targetPort: row.target_port,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      aiModel: row.ai_model,
      totalTokens: row.total_tokens,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      estimatedCost: row.estimated_cost
        ? parseFloat(row.estimated_cost)
        : undefined,
      discoveredCIs: row.discovered_cis || [],
      confidenceScore: row.confidence_score
        ? parseFloat(row.confidence_score)
        : undefined,
      toolCalls: row.tool_calls || [],
      aiReasoning: row.ai_reasoning,
      patternMatched: row.pattern_matched,
      errorMessage: row.error_message,
      retryCount: row.retry_count || 0,
    };
  }
}
