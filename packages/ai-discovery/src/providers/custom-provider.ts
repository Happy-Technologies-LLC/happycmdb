// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom/Private LLM Provider
 * Implements AI discovery using OpenAI-compatible API for private/self-hosted models
 * Compatible with: vLLM, Ollama, LocalAI, Text Generation Inference, etc.
 */

import OpenAI from 'openai';
import { BaseLLMProvider } from './base-provider';
import { AIDiscoveryContext, DiscoveryTool, AIToolCall } from '../types';
import { DISCOVERY_TARGET_REFUSED, logger } from '@cmdb/common';

export class CustomProvider extends BaseLLMProvider {
  private client: OpenAI;

  constructor(config: any) {
    super(config);

    if (!config.baseURL) {
      throw new Error('Custom provider requires baseURL for the model endpoint');
    }

    this.client = new OpenAI({
      apiKey: config.apiKey || 'not-needed', // Some private deployments don't need auth
      baseURL: config.baseURL, // e.g., http://localhost:8000/v1 for vLLM
    });
  }

  get name(): string {
    return 'custom';
  }

  /**
   * Execute discovery with custom LLM using OpenAI-compatible API
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

    // Convert tools to OpenAI format (if model supports tool calling)
    const openaiTools: OpenAI.ChatCompletionTool[] | undefined =
      this.supportsToolCalling()
        ? tools.map(tool => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          }))
        : undefined;

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
      // If model doesn't support tool calling, use single-turn with tool descriptions in prompt
      if (!this.supportsToolCalling()) {
        return await this.discoverWithoutToolCalling(
          context,
          tools,
          systemPrompt,
          userPrompt
        );
      }

      // Main discovery loop (with tool calling)
      let continueLoop = true;
      let iterationCount = 0;
      const maxIterations = 10;

      while (continueLoop && iterationCount < maxIterations) {
        iterationCount++;

        logger.debug(`Custom LLM iteration ${iterationCount}`);

        const response = await this.client.chat.completions.create({
          model: this.config.model || 'default',
          messages,
          tools: openaiTools,
          tool_choice: 'auto',
          temperature: this.config.temperature ?? 0.1,
          max_tokens: this.config.maxTokens || 4096,
        });

        const choice = response.choices[0];

        // Track token usage (if provided)
        if (response.usage) {
          totalPromptTokens += response.usage.prompt_tokens || 0;
          totalCompletionTokens += response.usage.completion_tokens || 0;
        }

        logger.debug('Custom LLM response received', {
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
            logger.info('Custom LLM requested discovery tool', { toolName: tool.name });

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

          continueLoop = true;
        } else {
          // No more function calls, get final reasoning
          if (choice.message.content) {
            reasoning += choice.message.content + '\n';
          }
          continueLoop = false;
        }

        if (choice.finish_reason === 'stop') {
          continueLoop = false;
        }
      }

      // Private models have no cost
      const cost = 0.0;

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
      logger.error('Custom LLM discovery error');
      throw new Error('AI provider request failed');
    }
  }

  /**
   * Fallback method for models that don't support tool calling
   * Uses prompt engineering to simulate tool use
   */
  private async discoverWithoutToolCalling(
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
    logger.warn(
      'Model does not support tool calling, using manual execution mode'
    );

    // For models without tool calling, we'll do manual sequential execution
    // This is a simplified approach - in production, you might want to parse
    // structured output or use a more sophisticated prompt

    const toolCalls: AIToolCall[] = [];
    let reasoning = '';
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    // Create enhanced prompt with tool descriptions
    const enhancedPrompt = `${systemPrompt}\n\n${userPrompt}\n\nAvailable tools:\n${tools
      .map(
        (t, i) =>
          `${i + 1}. ${t.name}: ${t.description}\n   Parameters: ${JSON.stringify(t.inputSchema)}`
      )
      .join('\n\n')}

Please analyze the target and provide your reasoning about the service type, technology, and dependencies.`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.config.model || 'default',
        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: enhancedPrompt,
          },
        ],
        temperature: this.config.temperature ?? 0.1,
        max_tokens: this.config.maxTokens || 4096,
      });

      const choice = response.choices[0];

      if (response.usage) {
        totalPromptTokens = response.usage.prompt_tokens || 0;
        totalCompletionTokens = response.usage.completion_tokens || 0;
      }

      if (choice.message.content) {
        reasoning = choice.message.content;
      }

      // Note: Without tool calling, we can't execute discovery tools automatically
      // The model would need to request specific tools in its output,
      // and we'd parse that output to execute tools
      // For now, we just return the reasoning without tool execution

      logger.info(
        'Completed discovery without tool calling (reasoning only)'
      );

      return {
        reasoning: reasoning.trim(),
        toolCalls,
        totalTokens: totalPromptTokens + totalCompletionTokens,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        cost: 0.0,
      };
    } catch {
      logger.error('Custom LLM discovery error (no tool calling)');
      throw new Error('AI provider request failed');
    }
  }

  /**
   * Check if model supports tool calling
   * Can be overridden based on model capabilities
   */
  private supportsToolCalling(): boolean {
    // Check model name for known tool-calling capable models
    const model = (this.config.model || '').toLowerCase();

    // Most modern open-source models support tool calling
    // But some older ones don't
    const toolCallingModels = [
      'llama-3',
      'mixtral',
      'mistral',
      'qwen',
      'gemma',
      'phi-3',
    ];

    return toolCallingModels.some(m => model.includes(m));
  }

  /**
   * Test connection to custom LLM endpoint
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.config.model || 'default',
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
      logger.error('Custom LLM connection test failed');
      return false;
    }
  }
}
