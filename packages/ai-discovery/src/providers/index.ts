// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * LLM Provider Factory
 * Creates appropriate provider based on configuration
 */

import { ILLMProvider, LLMConfig, LLMProvider } from '../types';
import { AnthropicProvider } from './anthropic-provider';
import { OpenAIProvider } from './openai-provider';
import { CustomProvider } from './custom-provider';
import { logger } from '@cmdb/common';

export * from './base-provider';
export * from './anthropic-provider';
export * from './openai-provider';
export * from './custom-provider';

/**
 * Create LLM provider based on configuration
 */
export function createLLMProvider(config: LLMConfig): ILLMProvider {
  logger.info('Creating LLM provider', { hasApiKey: !!config.apiKey });

  switch (config.provider) {
    case LLMProvider.ANTHROPIC:
      return new AnthropicProvider(config);

    case LLMProvider.OPENAI:
      return new OpenAIProvider(config);

    case LLMProvider.CUSTOM:
      return new CustomProvider(config);

    default:
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
  }
}

/**
 * Get default LLM configuration from environment
 */
export function getDefaultLLMConfig(): LLMConfig {
  const provider = (process.env['AI_DISCOVERY_PROVIDER'] || 'anthropic').toLowerCase();

  let providerEnum: LLMProvider;
  switch (provider) {
    case 'anthropic':
      providerEnum = LLMProvider.ANTHROPIC;
      break;
    case 'openai':
      providerEnum = LLMProvider.OPENAI;
      break;
    case 'custom':
      providerEnum = LLMProvider.CUSTOM;
      break;
    default:
      throw new Error(`Invalid provider in AI_DISCOVERY_PROVIDER: ${provider}`);
  }

  return {
    provider: providerEnum,
    model:
      process.env['AI_DISCOVERY_MODEL'] ||
      (providerEnum === LLMProvider.ANTHROPIC
        ? 'claude-sonnet-4-20250514'
        : providerEnum === LLMProvider.OPENAI
        ? 'gpt-4-turbo-preview'
        : 'default'),
    apiKey:
      process.env['ANTHROPIC_API_KEY'] ||
      process.env['OPENAI_API_KEY'] ||
      process.env['AI_DISCOVERY_API_KEY'],
    baseURL: process.env['AI_DISCOVERY_BASE_URL'],
    temperature: parseFloat(process.env['AI_DISCOVERY_TEMPERATURE'] || '0.1'),
    maxTokens: parseInt(process.env['AI_DISCOVERY_MAX_TOKENS'] || '4096', 10),
    timeout: parseInt(process.env['AI_DISCOVERY_TIMEOUT_MS'] || '60000', 10),
  };
}

/**
 * Test LLM provider connection
 */
export async function testLLMConnection(config?: LLMConfig): Promise<boolean> {
  try {
    const llmConfig = config || getDefaultLLMConfig();
    const provider = createLLMProvider(llmConfig);

    logger.info('Testing LLM connection');

    const result = await provider.testConnection();

    if (result) {
      logger.info('LLM connection test successful');
    } else {
      logger.error('LLM connection test failed');
    }

    return result;
  } catch {
    logger.error('LLM connection test error');
    return false;
  }
}
