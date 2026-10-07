// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@cmdb/common';
import { OpenAIProvider } from '../openai-provider';
import { CustomProvider } from '../custom-provider';
import { AnthropicProvider } from '../anthropic-provider';
import { AIAgentCoordinator } from '../../ai-agent-coordinator';
import type { DiscoveryTool } from '../../types';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => ({ __esModule: true, default: jest.fn() }));
const secret = 'SENSITIVE-TEST-VALUE';
const openaiCreate = jest.fn();
const anthropicCreate = jest.fn();
const context = { targetHost: '8.8.8.8', targetPort: 443 };

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(OpenAI).mockImplementation(() => ({ chat: { completions: { create: openaiCreate } } }) as never);
  jest.mocked(Anthropic).mockImplementation(() => ({ messages: { create: anthropicCreate } }) as never);
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    jest.spyOn(logger, level).mockImplementation(() => undefined);
  }
});
afterEach(() => jest.restoreAllMocks());

function setResponse(provider: string, toolName: string, args: Record<string, unknown>): void {
  if (provider === 'anthropic') {
    anthropicCreate.mockResolvedValueOnce({ content: [
      { type: 'tool_use', name: toolName, input: args, id: 'id' },
    ], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } });
    anthropicCreate.mockResolvedValueOnce({ content: [
      { type: 'text', text: `model echoed ${secret}` },
    ], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  } else {
    openaiCreate.mockResolvedValueOnce({ choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', tool_calls: [{ id: 'id', type: 'function', function: {
        name: toolName, arguments: JSON.stringify(args),
      } }],
    } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    openaiCreate.mockResolvedValueOnce({ choices: [{ finish_reason: 'stop',
      message: { role: 'assistant', content: 'done' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }
}

const providers = {
  openai: () => new OpenAIProvider({ provider: 'openai', model: 'gpt-4', apiKey: 'unused' }),
  custom: () => new CustomProvider({ provider: 'custom', model: 'llama-3', baseURL: 'http://unused.invalid' }),
  anthropic: () => new AnthropicProvider({ provider: 'anthropic', model: 'claude', apiKey: 'unused' }),
};

it.each(['openai', 'custom', 'anthropic'] as const)(
  '%s keeps successful and failed tool arguments/results out of logs', async (name) => {
    const tool: DiscoveryTool = { name: 'ssh_execute', description: 'test tool',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      execute: jest.fn().mockResolvedValue({ stdout: `result ${secret}` }),
    };
    const args = { command: `echo password=${secret}` };
    setResponse(name, tool.name, args);
    const provider = providers[name]();
    const success = await provider.discover(context, [tool], 'system', 'user');
    expect(success.toolCalls[0]).toMatchObject({ success: true });
    expect(success.toolCalls[0]?.output).toEqual({ stdout: `result ${secret}` });
    expect(JSON.stringify([jest.mocked(logger.debug).mock.calls, jest.mocked(logger.info).mock.calls,
      jest.mocked(logger.error).mock.calls])).not.toContain(secret);

    jest.mocked(logger.debug).mockClear();
    jest.mocked(logger.info).mockClear();
    jest.mocked(logger.error).mockClear();
    jest.mocked(tool.execute).mockRejectedValue(new Error(`remote echoed ${secret}`));
    setResponse(name, tool.name, args);
    const failure = await provider.discover(context, [tool], 'system', 'user');
    expect(failure.toolCalls[0]?.error).toBe('Tool execution failed');
    expect(failure.toolCalls[0]?.success).toBe(false);
    expect(failure.toolCalls[0]?.error).not.toContain(secret);
    expect(JSON.stringify([jest.mocked(logger.debug).mock.calls, jest.mocked(logger.info).mock.calls,
      jest.mocked(logger.error).mock.calls])).not.toContain(secret);
  }
);

it('does not log invalid model-controlled tool input before validation', async () => {
  const tool: DiscoveryTool = { name: 'http_probe', description: 'test tool',
    inputSchema: { type: 'object', properties: { host: { type: 'string' }, path: { type: 'string' } },
      required: ['host'] }, execute: jest.fn(),
  };
  setResponse('openai', tool.name, { path: `/password/${secret}?token=${secret}` });
  const result = await providers.openai().discover(context, [tool], 'system', 'user');
  expect(result.toolCalls).toEqual([]);
  expect(tool.execute).not.toHaveBeenCalled();
  expect(JSON.stringify([jest.mocked(logger.debug).mock.calls, jest.mocked(logger.info).mock.calls,
    jest.mocked(logger.error).mock.calls])).not.toContain(secret);
});

it.each(['openai', 'custom', 'anthropic'] as const)(
  '%s does not report an upstream error echoing submitted discovery data', async (name) => {
    const create = name === 'anthropic' ? anthropicCreate : openaiCreate;
    create.mockRejectedValueOnce(new Error(`request contained command=password=${secret}`));
    await expect(providers[name]().discover(context, [], 'system', 'user'))
      .rejects.toThrow('AI provider request failed');
    expect(JSON.stringify([jest.mocked(logger.debug).mock.calls, jest.mocked(logger.info).mock.calls,
      jest.mocked(logger.error).mock.calls])).not.toContain(secret);
  }
);

it('does not log unknown model-controlled tool names', async () => {
  setResponse('anthropic', `unknown-${secret}`, { command: secret });
  const result = await providers.anthropic().discover(context, [], 'system', 'user');
  expect(result.toolCalls).toEqual([]);
  expect(JSON.stringify([jest.mocked(logger.debug).mock.calls, jest.mocked(logger.info).mock.calls,
    jest.mocked(logger.error).mock.calls])).not.toContain(secret);
});

it('does not return or log upstream request errors through coordinator', async () => {
  openaiCreate.mockRejectedValueOnce(new Error(`provider echoed command=${secret}`));
  const result = await new AIAgentCoordinator({ provider: 'openai', model: 'gpt-4',
    apiKey: 'unused' }, []).discover(context);
  expect(result.success).toBe(false);
  expect(result.error).toBe('AI discovery failed');
  expect(result.session.errorMessage).toBe('AI discovery failed');
  expect(JSON.stringify([jest.mocked(logger.debug).mock.calls, jest.mocked(logger.info).mock.calls,
    jest.mocked(logger.error).mock.calls])).not.toContain(secret);
});

it('retains the fixed egress refusal code without revealing the requested target', async () => {
  const tool: DiscoveryTool = { name: 'http_probe', description: 'test tool',
    inputSchema: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] },
    execute: jest.fn().mockRejectedValue(new Error('Discovery target refused')),
  };
  setResponse('openai', tool.name, { host: `private-${secret}` });
  const result = await providers.openai().discover(context, [tool], 'system', 'user');
  expect(result.toolCalls[0]?.error).toBe('Discovery target refused');
  expect(JSON.stringify([jest.mocked(logger.debug).mock.calls, jest.mocked(logger.info).mock.calls,
    jest.mocked(logger.error).mock.calls])).not.toContain(secret);
});