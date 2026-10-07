// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Base LLM Provider
 * Abstract base class for all LLM providers
 */

import { ILLMProvider, LLMConfig, AIDiscoveryContext, DiscoveryTool, AIToolCall } from '../types';
import { DISCOVERY_TARGET_REFUSED, logger } from '@cmdb/common';

export abstract class BaseLLMProvider implements ILLMProvider {
  protected config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  abstract get name(): string;

  /**
   * Execute discovery with tool calling
   * Must be implemented by each provider
   */
  abstract discover(
    context: AIDiscoveryContext,
    tools: DiscoveryTool[],
    systemPrompt: string,
    userPrompt: string
  ): Promise<{
    reasoning: string;
    toolCalls: AIToolCall[];
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    cost: number;
  }>;

  /**
   * Test connection to LLM provider
   */
  abstract testConnection(): Promise<boolean>;

  /**
   * Generate system prompt for discovery
   */
  protected generateSystemPrompt(tools: DiscoveryTool[]): string {
    return `You are an expert infrastructure discovery agent. Your task is to identify and map services, applications, and infrastructure components.

Available Tools:
${tools.map(tool => `- ${tool.name}: ${tool.description}`).join('\n')}

Guidelines:
1. Think step-by-step about what information you need
2. Use tools strategically to gather information
3. Make inferences based on gathered data (banners, ports, endpoints, configs)
4. Identify service type, version, and dependencies
5. Document your reasoning clearly
6. Return high confidence scores only when you're certain

Your goal is to accurately identify the service and its dependencies with minimal tool calls.`;
  }

  /**
   * Generate user prompt for discovery
   */
  protected generateUserPrompt(context: AIDiscoveryContext): string {
    return `Discover and identify the service running on ${context.targetHost}:${context.targetPort}

${context.scanResult ? `Initial scan data:\n${JSON.stringify(context.scanResult, null, 2)}\n` : ''}

${context.credentials ? 'Credentials are available for authentication if needed.\n' : ''}

Identify:
1. Service type (e.g., web server, database, application)
2. Technology and version (e.g., "Spring Boot 2.7.0", "PostgreSQL 14.5")
3. Dependencies (databases, caches, message queues, etc.)
4. Configuration details
5. Confidence score (0.0 - 1.0)

Use available tools to gather information. Think step-by-step and explain your reasoning.`;
  }

  /**
   * Calculate estimated cost based on tokens
   * Override in provider-specific classes for accurate pricing
   */
  protected calculateCost(
    promptTokens: number,
    completionTokens: number
  ): number {
    // Default pricing (can be overridden by providers)
    const inputCostPer1M = 3.0; // $3 per 1M input tokens
    const outputCostPer1M = 15.0; // $15 per 1M output tokens

    const inputCost = (promptTokens / 1_000_000) * inputCostPer1M;
    const outputCost = (completionTokens / 1_000_000) * outputCostPer1M;

    return inputCost + outputCost;
  }

  /**
   * Execute a tool and track metrics
   */
  protected async executeTool(
    tool: DiscoveryTool,
    params: any
  ): Promise<AIToolCall> {
    const startTime = Date.now();
    const toolCall: AIToolCall = {
      id: `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      toolName: tool.name,
      input: params,
      output: null,
      success: false,
      executionTime: 0,
      timestamp: new Date(),
    };

    try {
      // Arguments and results are discovery data, not diagnostic metadata.
      logger.debug('Executing discovery tool', { toolName: tool.name });
      const result = await tool.execute(params);
      toolCall.output = result;
      toolCall.success = true;
      logger.debug('Discovery tool executed successfully', {
        toolName: tool.name,
        executionTime: Date.now() - startTime,
      });
    } catch (error) {
      toolCall.error = error instanceof Error && error.message === DISCOVERY_TARGET_REFUSED
        ? DISCOVERY_TARGET_REFUSED
        : 'Tool execution failed';
      toolCall.success = false;
      logger.error('Discovery tool execution failed', { toolName: tool.name });
    } finally {
      toolCall.executionTime = Date.now() - startTime;
    }

    return toolCall;
  }

  /**
   * Validate tool parameters against schema
   */
  protected validateToolParams(
    tool: DiscoveryTool,
    params: any
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const schema = tool.inputSchema;

    // Check required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in params)) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    // Basic type checking (can be extended)
    for (const [key, value] of Object.entries(params)) {
      if (key in schema.properties) {
        const propType = schema.properties[key].type;
        const actualType = typeof value;

        if (propType === 'string' && actualType !== 'string') {
          errors.push(`Field ${key} must be a string`);
        } else if (propType === 'number' && actualType !== 'number') {
          errors.push(`Field ${key} must be a number`);
        } else if (propType === 'boolean' && actualType !== 'boolean') {
          errors.push(`Field ${key} must be a boolean`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
