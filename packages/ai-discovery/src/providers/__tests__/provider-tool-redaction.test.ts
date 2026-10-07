// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'child_process';
import { logger } from '@cmdb/common';
import { OpenAIProvider } from '../openai-provider';
import { CustomProvider } from '../custom-provider';
import { AnthropicProvider } from '../anthropic-provider';
import { AIAgentCoordinator } from '../../ai-agent-coordinator';
import { HybridDiscoveryOrchestrator } from '../../hybrid-discovery-orchestrator';
import { nmapTool } from '../../tools/nmap-tool';
import type { DiscoveryTool } from '../../types';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('child_process', () => {
  const { promisify } = jest.requireActual('util');
  const fakeExecFile = jest.fn();
  // execFile's real promisify contract returns both stdout and stderr.
  fakeExecFile[promisify.custom] = (...args: unknown[]) => new Promise((resolve, reject) => {
    fakeExecFile(...args, (error: Error | null, stdout: string, stderr: string) =>
      error ? reject(error) : resolve({ stdout, stderr }));
  });
  return { ...jest.requireActual('child_process'), execFile: fakeExecFile };
});
const secret = 'SENSITIVE-TEST-VALUE';
const openaiCreate = jest.fn();
const anthropicCreate = jest.fn();
const context = { targetHost: '8.8.8.8', targetPort: 443 };

beforeEach(() => {
  jest.clearAllMocks();
  openaiCreate.mockReset();
  anthropicCreate.mockReset();
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

it.each(['openai', 'custom', 'anthropic'] as const)(
  '%s propagates the fixed egress refusal without logging the requested target', async (name) => {
    const tool: DiscoveryTool = { name: 'http_probe', description: 'test tool',
      inputSchema: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] },
      execute: jest.fn().mockRejectedValue(new Error('Discovery target refused')),
    };
    setResponse(name, tool.name, { host: `private-${secret}` });
    await expect(providers[name]().discover(context, [tool], 'system', 'user'))
      .rejects.toThrow('Discovery target refused');
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([jest.mocked(logger.debug).mock.calls, jest.mocked(logger.info).mock.calls,
      jest.mocked(logger.warn).mock.calls, jest.mocked(logger.error).mock.calls])).not.toContain(secret);
  }
);

it('refuses model-controlled nmap scan types without logging or spawning', async () => {
  const exec = jest.mocked(execFile);
  exec.mockImplementation((...callArgs: unknown[]) => {
    const callback = callArgs[callArgs.length - 1] as
      (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, 'Host is up', '');
    return {} as never;
  });
  const args = { host: '8.8.8.8', scanType: `password=${secret}` };
  setResponse('openai', nmapTool.name, args);
  const result = await providers.openai().discover(context, [nmapTool], 'system', 'user');
  expect(result.toolCalls[0]?.error).toBe('Tool execution failed');
  expect(exec).not.toHaveBeenCalled();
  expect(JSON.stringify([jest.mocked(logger.debug).mock.calls, jest.mocked(logger.info).mock.calls,
    jest.mocked(logger.warn).mock.calls, jest.mocked(logger.error).mock.calls])).not.toContain(secret);
});

it('runs a whitelisted nmap version scan without logging remote stderr', async () => {
  const exec = jest.mocked(execFile);
  exec.mockImplementation((...callArgs: unknown[]) => {
    const callback = callArgs[callArgs.length - 1] as
      (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, 'Host is up', `scanner echoed ${secret}`);
    return {} as never;
  });
  setResponse('openai', nmapTool.name, { host: '8.8.8.8', scanType: 'version' });
  const result = await providers.openai().discover(context, [nmapTool], 'system', 'user');
  expect(result.toolCalls[0]?.success).toBe(true);
  expect(exec).toHaveBeenCalledWith('nmap',
    ['-sV', '--top-ports', '100', '8.8.8.8', '-oX', '-'],
    expect.objectContaining({ timeout: 30000 }), expect.any(Function));
  expect(JSON.stringify([jest.mocked(logger.debug).mock.calls, jest.mocked(logger.info).mock.calls,
    jest.mocked(logger.warn).mock.calls, jest.mocked(logger.error).mock.calls])).not.toContain(secret);

  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    jest.mocked(logger[level]).mockClear();
  }
  exec.mockImplementation((...callArgs: unknown[]) => {
    const callback = callArgs[callArgs.length - 1] as
      (error: Error | null, stdout: string, stderr: string) => void;
    callback(new Error(`scanner echoed ${secret}`), '', '');
    return {} as never;
  });
  setResponse('openai', nmapTool.name, { host: '8.8.8.8', scanType: 'version' });
  const failed = await providers.openai().discover(context, [nmapTool], 'system', 'user');
  expect(failed.toolCalls[0]?.error).toBe('Tool execution failed');
  expect(JSON.stringify([jest.mocked(logger.debug).mock.calls, jest.mocked(logger.info).mock.calls,
    jest.mocked(logger.warn).mock.calls, jest.mocked(logger.error).mock.calls])).not.toContain(secret);
});

it('fails coordinator and hybrid discovery when a public-target AI tool refuses a private destination', async () => {
  const tool: DiscoveryTool = { name: 'http_probe', description: 'test tool',
    inputSchema: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] },
    execute: jest.fn().mockRejectedValue(new Error('Discovery target refused')),
  };
  const config = { provider: 'openai' as const, model: 'gpt-4', apiKey: 'unused' };
  const coordinator = new AIAgentCoordinator(config, [tool]);
  setResponse('openai', tool.name, { host: '10.0.0.1' });
  const direct = await coordinator.discover(context);
  expect(direct).toMatchObject({ success: false, error: 'Discovery target refused',
    discoveredCIs: [], session: { status: 'failed', errorMessage: 'Discovery target refused' } });

  const hybrid = new HybridDiscoveryOrchestrator({
    aiEnabled: false, patternMatchingEnabled: false, monthlyBudget: 0,
  });
  hybrid.updateConfig({ aiEnabled: true });
  (hybrid as any).aiCoordinator = coordinator;
  openaiCreate.mockReset();
  setResponse('openai', tool.name, { host: '10.0.0.1' });
  const routed = await hybrid.discover(context);
  expect(routed).toMatchObject({ success: false, error: 'Discovery target refused',
    discoveredCIs: [], method: 'ai' });
  expect(tool.execute).toHaveBeenCalledTimes(2);
});