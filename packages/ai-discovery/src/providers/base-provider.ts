// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Base LLM Provider
 * Abstract base class for all LLM providers
 */

import { ILLMProvider, LLMConfig, AIDiscoveryContext, DiscoveryTool, AIToolCall } from '../types';
import { DISCOVERY_TARGET_REFUSED, logger } from '@cmdb/common';

/**
 * Tools that open a connection to a host the model names. They may only be
 * pointed at the session's own target (`AIDiscoveryContext.targetHost`): the
 * model's tool arguments are influenced by text from scanned hosts, so the
 * host argument is never trusted. A discovery definition carries no allowed
 * ranges to widen this (checked 2026-11): the session target is the scope.
 */
export const TARGET_SCOPED_TOOLS: ReadonlySet<string> = new Set([
  'nmap_scan', 'http_probe', 'ssh_execute', 'ssh_read_file',
]);

/**
 * Most characters of one tool result serialized for the model (about 4k
 * tokens). Applies to every tool; the session record keeps the full output.
 */
export const MAX_TOOL_RESULT_CHARS = 16000;

/** Compare hosts case-insensitively, ignoring one trailing dot and IPv6 brackets. */
function normalizeHost(host: string): string {
  let value = host.toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  return value.endsWith('.') ? value.slice(0, -1) : value;
}

function isSessionTarget(context: AIDiscoveryContext, host: unknown): boolean {
  return typeof host === 'string' && typeof context?.targetHost === 'string' &&
    host !== '' && normalizeHost(host) === normalizeHost(context.targetHost);
}

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
   * Serialize a tool call for the model, cut at MAX_TOOL_RESULT_CHARS.
   */
  protected formatToolResult(toolCall: AIToolCall): string {
    if (!toolCall.success) {
      return `Error: ${toolCall.error}`;
    }
    const serialized = JSON.stringify(toolCall.output) ?? 'null';
    if (serialized.length <= MAX_TOOL_RESULT_CHARS) {
      return serialized;
    }
    let cut = serialized.slice(0, MAX_TOOL_RESULT_CHARS);
    // Never end on half of a surrogate pair.
    if (/[\ud800-\udbff]$/.test(cut)) {
      cut = cut.slice(0, -1);
    }
    return `${cut}... [tool result truncated: ${serialized.length} characters, limit ${MAX_TOOL_RESULT_CHARS}]`;
  }

  /**
   * Execute a tool and track metrics
   */
  protected async executeTool(
    tool: DiscoveryTool,
    params: any,
    context: AIDiscoveryContext
  ): Promise<AIToolCall> {
    if (TARGET_SCOPED_TOOLS.has(tool.name) && !isSessionTarget(context, params?.host)) {
      // Fixed error and no target in the log: the host is model/scanned-host text.
      logger.warn('Discovery tool target outside session scope', { toolName: tool.name });
      throw new Error(DISCOVERY_TARGET_REFUSED);
    }

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
      if (error instanceof Error && error.message === DISCOVERY_TARGET_REFUSED) {
        logger.warn('Discovery tool target refused', { toolName: tool.name });
        throw new Error(DISCOVERY_TARGET_REFUSED);
      }
      toolCall.error = 'Tool execution failed';
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
