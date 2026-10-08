// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Anthropic Claude Provider
 * Implements AI discovery using Claude API with tool calling
 */

import Anthropic from '@anthropic-ai/sdk';
import { BaseLLMProvider } from './base-provider';
import { AIDiscoveryContext, DiscoveryTool, AIToolCall } from '../types';
import { DISCOVERY_TARGET_REFUSED, logger } from '@cmdb/common';

export class AnthropicProvider extends BaseLLMProvider {
  private client: Anthropic;

  constructor(config: any) {
    super(config);

    if (!config.apiKey) {
      throw new Error('Anthropic API key is required');
    }

    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL, // Support custom base URL for proxies
    });
  }

  get name(): string {
    return 'anthropic';
  }

  /**
   * Execute discovery with Claude tool calling
   */
  async discover(
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
  }> {
    const toolCalls: AIToolCall[] = [];
    let reasoning = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Convert tools to Anthropic format
    const anthropicTools = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));

    // Prepare messages
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: systemPrompt + '\n\n' + userPrompt,
      },
    ];

    try {
      // Main discovery loop (allow multiple turns for tool use)
      let continueLoop = true;
      let iterationCount = 0;
      const maxIterations = 10; // Prevent infinite loops

      while (continueLoop && iterationCount < maxIterations) {
        iterationCount++;

        logger.debug(`Claude iteration ${iterationCount}`);

        const response = await this.client.messages.create({
          model: this.config.model || 'claude-sonnet-4-20250514',
          max_tokens: this.config.maxTokens || 4096,
          temperature: this.config.temperature ?? 0.1,
          tools: anthropicTools,
          messages,
        });

        // Track token usage
        totalInputTokens += response.usage.input_tokens;
        totalOutputTokens += response.usage.output_tokens;

        logger.debug('Claude response received', {
          contentBlocks: response.content.length,
        });

        // Process response content
        for (const block of response.content) {
          if (block.type === 'text') {
            // Accumulate reasoning text
            reasoning += block.text + '\n';
          } else if (block.type === 'tool_use') {
            // Execute tool
            const toolName = block.name;
            const toolInput = block.input as any;
            const toolId = block.id;


            // Find tool
            const tool = tools.find(t => t.name === toolName);
            if (!tool) {
              logger.error('Unknown discovery tool requested');
              continue;
            }

            // Validate params
            const validation = this.validateToolParams(tool, toolInput);
            if (!validation.valid) {
              logger.error('Discovery tool parameter validation failed', {
                toolName: tool.name,
                errorCount: validation.errors.length,
              });
              continue;
            }
            logger.info('Claude requested discovery tool', { toolName: tool.name });

            // Execute tool
            const toolCall = await this.executeTool(tool, toolInput);
            toolCall.id = toolId;
            toolCalls.push(toolCall);

            // Add tool result to messages
            messages.push({
              role: 'assistant',
              content: response.content,
            });

            messages.push({
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolId,
                  content: toolCall.success
                    ? JSON.stringify(toolCall.output)
                    : `Error: ${toolCall.error}`,
                },
              ],
            });
          }
        }

        // Check if Claude wants to continue or is done
        if (response.stop_reason === 'end_turn') {
          // Claude finished without tool use
          continueLoop = false;
        } else if (response.stop_reason === 'tool_use') {
          // Claude used tools, continue loop to get next response
          continueLoop = true;
        } else {
          // Max tokens or other stop reason
          continueLoop = false;
        }
      }

      // Calculate cost (Claude Sonnet 3.5 pricing)
      const cost = this.calculateClaudeCost(totalInputTokens, totalOutputTokens);

      return {
        reasoning: reasoning.trim(),
        toolCalls,
        totalTokens: totalInputTokens + totalOutputTokens,
        promptTokens: totalInputTokens,
        completionTokens: totalOutputTokens,
        cost,
      };
    } catch (error) {
      if (error instanceof Error && error.message === DISCOVERY_TARGET_REFUSED) throw error;
      logger.error('Anthropic discovery error');
      throw new Error('AI provider request failed');
    }
  }

  /**
   * Calculate cost for Claude API
   * Pricing as of 2025: https://www.anthropic.com/pricing
   */
  private calculateClaudeCost(inputTokens: number, outputTokens: number): number {
    // Claude Sonnet 3.5 pricing (may vary by model)
    const model = this.config.model || 'claude-sonnet-4-20250514';

    let inputCostPer1M = 3.0;
    let outputCostPer1M = 15.0;

    if (model.includes('opus')) {
      inputCostPer1M = 15.0;
      outputCostPer1M = 75.0;
    } else if (model.includes('haiku')) {
      inputCostPer1M = 0.25;
      outputCostPer1M = 1.25;
    }

    const inputCost = (inputTokens / 1_000_000) * inputCostPer1M;
    const outputCost = (outputTokens / 1_000_000) * outputCostPer1M;

    return inputCost + outputCost;
  }

  /**
   * Test connection to Anthropic API
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.client.messages.create({
        model: this.config.model || 'claude-sonnet-4-20250514',
        max_tokens: 10,
        messages: [
          {
            role: 'user',
            content: 'Hello',
          },
        ],
      });

      return response.content.length > 0;
    } catch {
      logger.error('Anthropic connection test failed');
      return false;
    }
  }
}
