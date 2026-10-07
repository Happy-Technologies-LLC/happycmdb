// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Pattern Compiler
 * Generates data-only detection and discovery plans from discovery sessions.
 */

import { AIDiscoverySession, DiscoveryPattern, IPatternCompiler } from './types';
import { PatternAnalyzer, PatternCandidate } from './pattern-analyzer';
import { logger } from '@cmdb/common';
import { parseDetectionPlan, parseDiscoveryPlan, DetectionPlan, DiscoveryPlan } from './pattern-plan';

export class PatternCompiler implements IPatternCompiler {
  private analyzer: PatternAnalyzer;

  constructor(analyzer?: PatternAnalyzer) {
    this.analyzer = analyzer || new PatternAnalyzer();
  }

  /**
   * Analyze session to check if it's part of a pattern
   */
  async analyzeSession(session: AIDiscoverySession): Promise<boolean> {
    const result = await this.analyzer.analyzeSession(session);
    return result.isPattern;
  }

  /**
   * Compile pattern from multiple discovery sessions
   */
  async compilePattern(sessions: AIDiscoverySession[]): Promise<DiscoveryPattern> {
    if (sessions.length === 0) {
      throw new Error('No sessions provided for pattern compilation');
    }

    logger.info('Compiling pattern from sessions', {
      sessionCount: sessions.length,
    });

    // Analyze sessions to build candidate
    const result = await this.analyzer.analyzeSession(sessions[0]);
    if (!result.candidate) {
      throw new Error('Unable to build pattern candidate from sessions');
    }

    const candidate = result.candidate;

    // Generate detection code
    const detectionCode = this.generateDetectionCode(candidate);

    // Generate discovery code
    const discoveryCode = this.generateDiscoveryCode(candidate, sessions);

    // Generate test cases
    const testCases = this.generateTestCases(candidate, sessions);

    // Build pattern object
    const pattern: Omit<DiscoveryPattern, 'id'> = {
      patternId: this.generatePatternId(candidate),
      name: candidate.suggestedName,
      version: '1.0.0',
      category: candidate.suggestedCategory,
      detectionCode,
      discoveryCode,
      description: `Auto-generated pattern for ${candidate.suggestedName}`,
      author: 'ai-compiler',
      license: 'MIT',
      confidenceScore: candidate.signature.confidenceScore,
      usageCount: 0,
      successCount: 0,
      failureCount: 0,
      learnedFromSessions: candidate.signature.sessions,
      aiModel: sessions[0].aiModel,
      status: 'draft',
      isActive: false,
      testCases,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    logger.info('Pattern compiled successfully', {
      patternId: pattern.patternId,
      name: pattern.name,
      category: pattern.category,
    });

    return pattern as DiscoveryPattern;
  }

  /**
   * Validate generated pattern
   */
  async validatePattern(pattern: DiscoveryPattern): Promise<{
    isValid: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];
    try {
      parseDetectionPlan(pattern.detectionCode);
      parseDiscoveryPlan(pattern.discoveryCode);
    } catch {
      errors.push('UNSUPPORTED_PATTERN_PLAN');
    }
    // Validate test cases
    if (!pattern.testCases || pattern.testCases.length === 0) {
      errors.push('Pattern must have at least one test case');
    }

    const isValid = errors.length === 0;

    if (isValid) {
      logger.info('Pattern validation passed', { patternId: pattern.patternId });
    } else {
      logger.warn('Pattern validation failed', {
        patternId: pattern.patternId,
        errors,
      });
    }

    return { isValid, errors };
  }

  /** Serialize a fixed schema; no candidate data is interpolated into source code. */
  private generateDetectionCode(candidate: PatternCandidate): string {
    const plan: DetectionPlan = {
      kind: 'detection-v1',
      ports: candidate.commonElements.ports,
      headers: candidate.commonElements.headers.map(header => header.split(':')[0]),
      endpoints: candidate.commonElements.endpoints,
      serviceNames: candidate.commonElements.serviceNames,
    };
    return JSON.stringify(plan);
  }

  private generateDiscoveryCode(
    candidate: PatternCandidate,
    _sessions: AIDiscoverySession[]
  ): string {
    const plan: DiscoveryPlan = {
      kind: 'discovery-v1',
      name: candidate.suggestedName,
      category: candidate.suggestedCategory,
      serviceType: this.mapCategoryToServiceType(candidate.suggestedCategory),
      endpoints: candidate.commonElements.endpoints.slice(0, 3),
    };
    return JSON.stringify(plan);
  }

  /**
   * Generate test cases from sessions
   */
  private generateTestCases(
    candidate: PatternCandidate,
    sessions: AIDiscoverySession[]
  ): any[] {
    const testCases: any[] = [];

    // Take first session as test case
    const testSession = sessions[0];

    testCases.push({
      name: 'Detection test',
      input: (testSession as any).scanResult || testSession.discoveredCIs || {},
      expected: {
        matches: true,
        confidenceMin: 0.5,
      },
    });

    // Add port test if applicable
    if (candidate.commonElements.ports.length > 0) {
      testCases.push({
        name: 'Port detection',
        input: {
          services: [{ port: candidate.commonElements.ports[0], service: 'http' }],
        },
        expected: {
          matches: true,
          confidenceMin: 0.3,
        },
      });
    }

    // Add endpoint test if applicable
    if (candidate.commonElements.endpoints.length > 0) {
      testCases.push({
        name: 'Endpoint detection',
        input: {
          http: {
            endpoints: candidate.commonElements.endpoints,
          },
        },
        expected: {
          matches: true,
          confidenceMin: 0.5,
        },
      });
    }

    return testCases;
  }

  /**
   * Generate pattern ID from candidate
   */
  private generatePatternId(candidate: PatternCandidate): string {
    return candidate.suggestedName
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '');
  }

  /**
   * Map category to CI service type
   */
  private mapCategoryToServiceType(category: string): string {
    const mapping: Record<string, string> = {
      'databases': 'database',
      'caching': 'cache',
      'web-servers': 'web-server',
      'message-queues': 'message-queue',
      'search-engines': 'search-engine',
      'container-platforms': 'container-platform',
      'java-frameworks': 'application',
      'nodejs-frameworks': 'application',
      'applications': 'application',
    };

    return mapping[category] || 'application';
  }

  /**
   * Get pattern candidates ready for compilation
   */
  async getCandidates(): Promise<PatternCandidate[]> {
    return await this.analyzer.getPatternCandidates();
  }
}
