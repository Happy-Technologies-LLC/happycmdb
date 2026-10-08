// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAI Provider
 * Implements AI discovery using OpenAI API with function calling
 */

import OpenAI from 'openai';
import { BaseLLMProvider } from './base-provider';
import { AIDiscoveryContext, DiscoveryTool, AIToolCall } from '../types';
import { DISCOVERY_TARGET_REFUSED, logger } from '@cmdb/common';

export class OpenAIProvider extends BaseLLMProvider {
  private client: OpenAI;

  constructor(config: any) {
    super(config);

    this.client = new OpenAI({
      apiKey: config.apiKey || process.env['OPENAI_API_KEY'],
      baseURL: config.baseURL, // Support custom base URL
    });
  }

  get name(): string {
    return 'openai';
  }

  /**
   * Execute discovery with OpenAI function calling
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
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    // Convert tools to OpenAI format
    const openaiTools: OpenAI.ChatCompletionTool[] = tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    // Prepare messages
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: userPrompt,
      },
    ];

    try {
      // Main discovery loop (allow multiple turns for function calling)
      let continueLoop = true;
      let iterationCount = 0;
      const maxIterations = 10; // Prevent infinite loops

      while (continueLoop && iterationCount < maxIterations) {
        iterationCount++;

        logger.debug(`OpenAI iteration ${iterationCount}`);

        const response = await this.client.chat.completions.create({
          model: this.config.model || 'gpt-4-turbo-preview',
          messages,
          tools: openaiTools,
          tool_choice: 'auto',
          temperature: this.config.temperature ?? 0.1,
          max_tokens: this.config.maxTokens || 4096,
        });

        const choice = response.choices[0];

        // Track token usage
        if (response.usage) {
          totalPromptTokens += response.usage.prompt_tokens;
          totalCompletionTokens += response.usage.completion_tokens;
        }

        logger.debug('OpenAI response received', {
          hasToolCalls: !!choice.message.tool_calls,
        });

        // Add assistant message to conversation
        messages.push(choice.message);

        // Check for function calls
        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
          // Execute each function call
          for (const toolCallMsg of choice.message.tool_calls) {
            const functionName = toolCallMsg.function.name;
            const functionArgs = JSON.parse(toolCallMsg.function.arguments);
            const toolId = toolCallMsg.id;


            // Find tool
            const tool = tools.find(t => t.name === functionName);
            if (!tool) {
              logger.error('Unknown discovery tool requested');
              continue;
            }

            // Validate params
            const validation = this.validateToolParams(tool, functionArgs);
            if (!validation.valid) {
              logger.error('Discovery tool parameter validation failed', {
                toolName: tool.name,
                errorCount: validation.errors.length,
              });
              continue;
            }
            logger.info('OpenAI requested discovery tool', { toolName: tool.name });

            // Execute tool
            const toolCall = await this.executeTool(tool, functionArgs);
            toolCall.id = toolId;
            toolCalls.push(toolCall);

            // Add tool result to messages
            messages.push({
              role: 'tool',
              tool_call_id: toolId,
              content: toolCall.success
                ? JSON.stringify(toolCall.output)
                : `Error: ${toolCall.error}`,
            });
          }

          // Continue loop to get next response
          continueLoop = true;
        } else {
          // No more function calls, get final reasoning
          if (choice.message.content) {
            reasoning += choice.message.content + '\n';
          }
          continueLoop = false;
        }

        // Check finish reason
        if (choice.finish_reason === 'stop') {
          continueLoop = false;
        }
      }

      // Calculate cost
      const cost = this.calculateOpenAICost(
        totalPromptTokens,
        totalCompletionTokens
      );

      return {
        reasoning: reasoning.trim(),
        toolCalls,
        totalTokens: totalPromptTokens + totalCompletionTokens,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        cost,
      };
    } catch (error) {
      if (error instanceof Error && error.message === DISCOVERY_TARGET_REFUSED) throw error;
      logger.error('OpenAI discovery error');
      throw new Error('AI provider request failed');
    }
  }

  /**
   * Calculate cost for OpenAI API
   * Pricing: https://openai.com/pricing
   */
  private calculateOpenAICost(
    promptTokens: number,
    completionTokens: number
  ): number {
    const model = this.config.model || 'gpt-4-turbo-preview';

    let inputCostPer1M = 10.0;
    let outputCostPer1M = 30.0;

    if (model.includes('gpt-4-turbo') || model.includes('gpt-4-1106')) {
      inputCostPer1M = 10.0;
      outputCostPer1M = 30.0;
    } else if (model.includes('gpt-4')) {
      inputCostPer1M = 30.0;
      outputCostPer1M = 60.0;
    } else if (model.includes('gpt-3.5')) {
      inputCostPer1M = 0.5;
      outputCostPer1M = 1.5;
    }

    const inputCost = (promptTokens / 1_000_000) * inputCostPer1M;
    const outputCost = (completionTokens / 1_000_000) * outputCostPer1M;

    return inputCost + outputCost;
  }

  /**
   * Test connection to OpenAI API
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.config.model || 'gpt-4-turbo-preview',
        messages: [
          {
            role: 'user',
            content: 'Hello',
          },
        ],
        max_tokens: 10,
      });

      return response.choices.length > 0;
    } catch {
      logger.error('OpenAI connection test failed');
      return false;
    }
  }
}
