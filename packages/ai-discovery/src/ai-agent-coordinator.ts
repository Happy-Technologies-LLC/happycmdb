// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * AI Agent Coordinator
 * Orchestrates AI-powered discovery using LLM providers and tools
 */

import {
  ILLMProvider,
  AIDiscoveryContext,
  AIDiscoverySession,
  AIDiscoveryResult,
  DiscoveryTool,
  LLMConfig,
} from './types';
import { createLLMProvider } from './providers';
import { getAllDiscoveryTools, getBasicDiscoveryTools } from './tools';
import { DISCOVERY_TARGET_REFUSED, logger } from '@cmdb/common';
import { v4 as uuidv4 } from 'uuid';

export class AIAgentCoordinator {
  private provider: ILLMProvider;
  private tools: DiscoveryTool[];
  private currentSession: AIDiscoverySession | null = null;

  constructor(llmConfig: LLMConfig, tools?: DiscoveryTool[]) {
    this.provider = createLLMProvider(llmConfig);
    this.tools = tools || getAllDiscoveryTools();

    logger.info('AI Agent Coordinator initialized', {
      provider: this.provider.name,
      tools: this.tools.map(t => t.name),
    });
  }

  /**
   * Execute AI-powered discovery
   */
  async discover(context: AIDiscoveryContext): Promise<AIDiscoveryResult> {
    const sessionId = `ai-discovery-${uuidv4()}`;
    const startTime = Date.now();

    // Initialize session
    this.currentSession = {
      id: uuidv4(),
      sessionId,
      targetHost: context.targetHost,
      targetPort: context.targetPort,
      status: 'running',
      startedAt: new Date(),
      aiModel: this.provider.name,
      toolCalls: [],
      retryCount: 0,
    };

    logger.info('Starting AI discovery', {
      sessionId,
      target: `${context.targetHost}:${context.targetPort}`,
    });

    try {
      // Generate prompts
      const systemPrompt = this.generateSystemPrompt();
      const userPrompt = this.generateUserPrompt(context);

      // Execute discovery with AI
      const result = await this.provider.discover(
        context,
        this.tools,
        systemPrompt,
        userPrompt
      );

      // Update session with results
      this.currentSession.toolCalls = result.toolCalls;
      this.currentSession.aiReasoning = result.reasoning;
      this.currentSession.totalTokens = result.totalTokens;
      this.currentSession.promptTokens = result.promptTokens;
      this.currentSession.completionTokens = result.completionTokens;
      this.currentSession.estimatedCost = result.cost;

      // Parse discovered CIs from AI reasoning and tool results
      const discoveredCIs = this.parseDiscoveredCIs(
        result.reasoning,
        result.toolCalls
      );

      // Calculate confidence score
      const confidence = this.calculateConfidence(result.toolCalls, result.reasoning);

      // Update session
      this.currentSession.discoveredCIs = discoveredCIs;
      this.currentSession.confidenceScore = confidence;
      this.currentSession.status = 'completed';
      this.currentSession.completedAt = new Date();
      this.currentSession.durationMs = Date.now() - startTime;

      logger.info('AI discovery completed', {
        sessionId,
        discovered: discoveredCIs.length,
        confidence,
        cost: result.cost,
        duration: this.currentSession.durationMs,
      });

      return {
        success: true,
        session: this.currentSession,
        discoveredCIs,
        confidence,
        executionTimeMs: this.currentSession.durationMs,
        cost: result.cost,
      };
    } catch (error) {
      // Provider, model, and remote errors can echo credentials or tool output.
      const errorMessage = error instanceof Error && error.message === DISCOVERY_TARGET_REFUSED
        ? DISCOVERY_TARGET_REFUSED
        : 'AI discovery failed';

      logger.error('AI discovery failed', { sessionId });

      if (this.currentSession) {
        this.currentSession.status = 'failed';
        this.currentSession.errorMessage = errorMessage;
        this.currentSession.completedAt = new Date();
        this.currentSession.durationMs = Date.now() - startTime;
      }

      return {
        success: false,
        session: this.currentSession!,
        discoveredCIs: [],
        confidence: 0,
        executionTimeMs: Date.now() - startTime,
        error: errorMessage,
      };
    }
  }

  /**
   * Generate system prompt for discovery
   */
  private generateSystemPrompt(): string {
    return `You are an expert infrastructure discovery agent. Your task is to identify and map services, applications, and infrastructure components.

Available Tools:
${this.tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}

Guidelines:
1. Think step-by-step about what information you need to identify the service
2. Use tools strategically to gather information (start with lightweight tools like nmap/http)
3. Make intelligent inferences based on gathered data:
   - HTTP headers (Server, X-Powered-By, X-Application-Context)
   - Open ports and their typical services
   - API endpoints (e.g., /actuator for Spring Boot, /health for common apps)
   - Banner information and service versions
4. Identify:
   - Service type (web server, app server, database, cache, queue, etc.)
   - Technology and version (e.g., "Spring Boot 2.7.0", "PostgreSQL 14")
   - Dependencies (what this service connects to)
5. Return high confidence scores only when you have strong evidence
6. If you're uncertain, gather more information with additional tool calls

Your goal is to accurately identify the service with minimal tool calls.`;
  }

  /**
   * Generate user prompt for discovery
   */
  private generateUserPrompt(context: AIDiscoveryContext): string {
    let prompt = `Discover and identify the service running on ${context.targetHost}:${context.targetPort}\n\n`;

    if (context.scanResult) {
      prompt += `Initial scan data:\n${JSON.stringify(context.scanResult, null, 2)}\n\n`;
    }

    if (context.credentials) {
      prompt += `Credentials are available if SSH access is needed.\n\n`;
    }

    prompt += `Please identify:
1. Service type (e.g., web server, database, application)
2. Technology and version (e.g., "Spring Boot 2.7.0", "Nginx 1.21")
3. Dependencies (databases, caches, message queues, external APIs)
4. Key configuration details
5. Your confidence score (0.0 - 1.0)

Think step-by-step, use tools wisely, and explain your reasoning clearly.`;

    return prompt;
  }

  /**
   * Parse discovered CIs from AI reasoning and tool results
   */
  private parseDiscoveredCIs(
    reasoning: string,
    toolCalls: any[]
  ): any[] {
    const cis: any[] = [];

    // This is a simplified parser
    // In production, you would use structured output from the LLM
    // or have the LLM explicitly mark discovered CIs

    // For now, we'll create a CI based on what we learned
    const ci: any = {
      _type: this.inferServiceType(reasoning, toolCalls),
      name: `Service on ${this.currentSession?.targetHost}:${this.currentSession?.targetPort}`,
      hostname: this.currentSession?.targetHost,
      metadata: {
        discoveryMethod: 'ai',
        aiReasoning: reasoning.substring(0, 500), // First 500 chars
        discoveredAt: new Date().toISOString(),
      },
    };

    // Extract technology/version from reasoning
    const techMatch = reasoning.match(
      /(?:technology|service|application|framework):\s*([^\n]+)/i
    );
    if (techMatch) {
      ci.metadata.technology = techMatch[1].trim();
    }

    const versionMatch = reasoning.match(/version:\s*([^\n]+)/i);
    if (versionMatch) {
      ci.metadata.version = versionMatch[1].trim();
    }

    // Extract dependencies mentioned in reasoning
    const dependencyMatches = [
      ...reasoning.matchAll(/(?:database|cache|queue|depends on):\s*([^\n]+)/gi),
    ];
    if (dependencyMatches.length > 0) {
      ci.metadata.dependencies = dependencyMatches.map(m => m[1].trim());
    }

    cis.push(ci);

    return cis;
  }

  /**
   * Infer service type from AI reasoning
   */
  private inferServiceType(reasoning: string, toolCalls: any[]): string {
    const lower = reasoning.toLowerCase();

    // Check for explicit service type mentions
    if (lower.includes('database')) return 'database';
    if (lower.includes('cache') || lower.includes('redis')) return 'cache';
    if (lower.includes('message queue') || lower.includes('kafka'))
      return 'message-queue';
    if (lower.includes('web server') || lower.includes('nginx'))
      return 'web-server';
    if (lower.includes('application') || lower.includes('app server'))
      return 'application';
    if (lower.includes('load balancer')) return 'load-balancer';

    // Check tool results
    for (const toolCall of toolCalls) {
      if (toolCall.toolName === 'http_probe' && toolCall.success) {
        return 'web-service';
      }
    }

    return 'unknown';
  }

  /**
   * Calculate confidence score based on tool calls and reasoning
   */
  private calculateConfidence(toolCalls: any[], reasoning: string): number {
    let confidence = 0.5; // Base confidence

    // Increase confidence based on successful tool calls
    const successfulCalls = toolCalls.filter(t => t.success).length;
    confidence += successfulCalls * 0.1;

    // Increase confidence if specific version was identified
    if (reasoning.match(/version:\s*[\d.]+/i)) {
      confidence += 0.2;
    }

    // Increase confidence if dependencies were identified
    if (
      reasoning.match(/(?:database|cache|queue|depends on):/i)
    ) {
      confidence += 0.1;
    }

    // Decrease confidence if reasoning mentions uncertainty
    if (
      reasoning.match(/(?:uncertain|unclear|might be|possibly|maybe)/i)
    ) {
      confidence -= 0.2;
    }

    // Cap at 1.0
    return Math.min(confidence, 1.0);
  }

  /**
   * Get current session (for pattern learning)
   */
  getCurrentSession(): AIDiscoverySession | null {
    return this.currentSession;
  }

  /**
   * Check if a repeatable pattern was found
   */
  foundNewPattern(): boolean {
    if (!this.currentSession || this.currentSession.toolCalls.length < 2) {
      return false;
    }

    // If discovery was successful and used a consistent sequence of tools,
    // it might be a pattern worth learning
    const allSuccessful = this.currentSession.toolCalls.every(t => t.success);
    const highConfidence = (this.currentSession.confidenceScore || 0) > 0.8;

    return allSuccessful && highConfidence;
  }
}
