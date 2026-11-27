// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { logger } from '@cmdb/common';
import { OpenAIProvider } from '../openai-provider';
import { CustomProvider } from '../custom-provider';
import { AnthropicProvider } from '../anthropic-provider';
import { MAX_TOOL_RESULT_CHARS } from '../base-provider';
import type { DiscoveryTool } from '../../types';

jest.mock('openai', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => ({ __esModule: true, default: jest.fn() }));

const openaiCreate = jest.fn();
const anthropicCreate = jest.fn();
const context = { targetHost: 'Target.Example', targetPort: 443 };
const REFUSED = 'Discovery target refused';

const providers = {
  openai: () => new OpenAIProvider({ provider: 'openai', model: 'gpt-4', apiKey: 'unused' } as never),
  custom: () => new CustomProvider({ provider: 'custom', model: 'llama-3', baseURL: 'http://unused.invalid' } as never),
  anthropic: () => new AnthropicProvider({ provider: 'anthropic', model: 'claude', apiKey: 'unused' } as never),
};
const names = ['openai', 'custom', 'anthropic'] as const;

beforeEach(() => {
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
    anthropicCreate.mockResolvedValueOnce({ content: [{ type: 'tool_use', name: toolName, input: args, id: 'id' }],
      stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } });
    anthropicCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
  } else {
    openaiCreate.mockResolvedValueOnce({ choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', tool_calls: [{ id: 'id', type: 'function', function: {
        name: toolName, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    openaiCreate.mockResolvedValueOnce({ choices: [{ finish_reason: 'stop',
      message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  }
}

/** A test tool: scope-checked and with a `host` parameter unless the options say otherwise. */
function tool(name: string, execute: jest.Mock,
  { targetScoped = true, properties = { host: { type: 'string' } } }:
    { targetScoped?: boolean; properties?: Record<string, unknown> } = {}): DiscoveryTool {
  return { name, description: 'test tool', execute, targetScoped,
    inputSchema: { type: 'object', properties, required: Object.keys(properties) } };
}

/** The content the provider sent back to the model for the tool call. */
function toolResultSent(provider: string): string {
  if (provider === 'anthropic') {
    const messages = anthropicCreate.mock.calls[1][0].messages;
    return messages[messages.length - 1].content[0].content;
  }
  // The same array is extended with the final assistant message after this call.
  const messages = openaiCreate.mock.calls[1][0].messages;
  return messages.find((message: { role: string }) => message.role === 'tool').content;
}

describe.each(names)('%s provider: tool calls stay on the session target', (name) => {
  it.each(['nmap_scan', 'http_probe', 'ssh_execute', 'ssh_read_file'])(
    'refuses %s against an injected second public host without running it', async (toolName) => {
      const execute = jest.fn().mockResolvedValue({ ok: true });
      // The model was told to scan another host by text inside a probe result.
      setResponse(name, toolName, { host: '1.1.1.1' });

      await expect(providers[name]().discover(context, [tool(toolName, execute)], 'system', 'user'))
        .rejects.toThrow(REFUSED);

      expect(execute).not.toHaveBeenCalled();
    });

  it.each(['1.1.1.1', 'target.example.evil.test', 'target.example@1.1.1.1', '8.8.8.8', '', 'x.Target.Example'])(
    'refuses %p, which is not the session target', async (host) => {
      const execute = jest.fn();
      setResponse(name, 'http_probe', { host });

      await expect(providers[name]().discover(context, [tool('http_probe', execute)], 'system', 'user'))
        .rejects.toThrow(REFUSED);
      expect(execute).not.toHaveBeenCalled();
    });

  it.each(['Target.Example', 'target.example', 'TARGET.EXAMPLE.'])(
    'runs a scoped tool against the session target written as %p', async (host) => {
      const execute = jest.fn().mockResolvedValue({ ok: true });
      setResponse(name, 'nmap_scan', { host });

      const result = await providers[name]().discover(context, [tool('nmap_scan', execute)], 'system', 'user');

      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.toolCalls[0]).toMatchObject({ success: true });
    });

  it('matches an IPv6 session target with or without brackets', async () => {
    const execute = jest.fn().mockResolvedValue({ ok: true });
    setResponse(name, 'http_probe', { host: '[2001:4860:4860::8888]' });

    await providers[name]().discover({ targetHost: '2001:4860:4860::8888', targetPort: 443 },
      [tool('http_probe', execute)], 'system', 'user');

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('refuses a scoped tool whose host is missing or not a string', async () => {
    for (const args of [{}, { host: 7 }, { host: ['target.example'] }]) {
      const execute = jest.fn();
      setResponse(name, 'ssh_execute', args);
      // validateToolParams may drop these before execution; either way nothing runs.
      await providers[name]().discover(context, [tool('ssh_execute', execute)], 'system', 'user').catch(() => undefined);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it('does not scope tools that take no network target', async () => {
    const execute = jest.fn().mockResolvedValue({ ok: true });
    setResponse(name, 'lookup_notes', { query: 'raid' });

    const result = await providers[name]().discover(context,
      [tool('lookup_notes', execute, { targetScoped: false, properties: { query: { type: 'string' } } })],
      'system', 'user');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.toolCalls[0]).toMatchObject({ success: true });
  });

  it('does not log the refused host', async () => {
    setResponse(name, 'nmap_scan', { host: 'secret-other-host.example' });

    await expect(providers[name]().discover(context, [tool('nmap_scan', jest.fn())], 'system', 'user'))
      .rejects.toThrow(REFUSED);

    const logged = JSON.stringify([jest.mocked(logger.debug).mock.calls, jest.mocked(logger.info).mock.calls,
      jest.mocked(logger.warn).mock.calls, jest.mocked(logger.error).mock.calls]);
    expect(logged).not.toContain('secret-other-host');
  });

  it('refuses a custom-named tool that has a host parameter but no targetScoped flag, before it runs', async () => {
    const execute = jest.fn().mockResolvedValue({ ok: true });
    // Even against the session's own host: the tool never declared that it is scope-checked.
    setResponse(name, 'banner_grab', { host: 'target.example' });

    await expect(providers[name]().discover(context, [tool('banner_grab', execute, { targetScoped: false })],
      'system', 'user')).rejects.toThrow(REFUSED);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses an unflagged tool that reuses a built-in tool name', async () => {
    const execute = jest.fn().mockResolvedValue({ ok: true });
    setResponse(name, 'http_probe', { host: 'target.example' });

    await expect(providers[name]().discover(context, [tool('http_probe', execute, { targetScoped: false })],
      'system', 'user')).rejects.toThrow(REFUSED);
    expect(execute).not.toHaveBeenCalled();
  });

  it('scope-checks any tool that sets targetScoped, whatever its name', async () => {
    const refused = jest.fn();
    setResponse(name, 'banner_grab', { host: '1.1.1.1' });
    await expect(providers[name]().discover(context, [tool('banner_grab', refused)], 'system', 'user'))
      .rejects.toThrow(REFUSED);
    expect(refused).not.toHaveBeenCalled();

    openaiCreate.mockReset();
    anthropicCreate.mockReset();
    const allowed = jest.fn().mockResolvedValue({ ok: true });
    setResponse(name, 'banner_grab', { host: 'target.example' });
    await providers[name]().discover(context, [tool('banner_grab', allowed)], 'system', 'user');
    expect(allowed).toHaveBeenCalledTimes(1);
  });

  it('refuses a host that only matches the session target after Unicode lowercasing', async () => {
    const execute = jest.fn();
    // U+212A KELVIN SIGN lowercases to ASCII "k".
    setResponse(name, 'http_probe', { host: '\u212Aey.example' });

    await expect(providers[name]().discover({ targetHost: 'key.example', targetPort: 443 },
      [tool('http_probe', execute)], 'system', 'user')).rejects.toThrow(REFUSED);
    expect(execute).not.toHaveBeenCalled();
  });

  it('still accepts the ASCII spelling of that target', async () => {
    const execute = jest.fn().mockResolvedValue({ ok: true });
    setResponse(name, 'http_probe', { host: 'KEY.example' });

    await providers[name]().discover({ targetHost: 'key.example', targetPort: 443 },
      [tool('http_probe', execute)], 'system', 'user');

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe.each(names)('%s provider: tool results sent to the model are size-capped', (name) => {
  it('cuts an oversized result at the documented limit and says so', async () => {
    const execute = jest.fn().mockResolvedValue({ banner: 'A'.repeat(MAX_TOOL_RESULT_CHARS * 4) });
    setResponse(name, 'http_probe', { host: 'target.example' });

    const result = await providers[name]().discover(context, [tool('http_probe', execute)], 'system', 'user');

    const sent = toolResultSent(name);
    expect(sent.startsWith('{"banner":"AAAA')).toBe(true);
    expect(sent).toContain('[tool result truncated');
    expect(sent.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 200);
    // The session record keeps the full output; only the model's copy is cut.
    expect(result.toolCalls[0]?.output.banner).toHaveLength(MAX_TOOL_RESULT_CHARS * 4);
  });

  it('sends a result of exactly the limit unchanged', async () => {
    const filler = 'B'.repeat(MAX_TOOL_RESULT_CHARS - JSON.stringify({ banner: '' }).length);
    const execute = jest.fn().mockResolvedValue({ banner: filler });
    setResponse(name, 'http_probe', { host: 'target.example' });

    await providers[name]().discover(context, [tool('http_probe', execute)], 'system', 'user');

    expect(toolResultSent(name)).toBe(JSON.stringify({ banner: filler }));
  });

  it('does not end a cut result on half of a surrogate pair', async () => {
    // `{"banner":"` is 11 characters: the first emoji's high surrogate lands on index LIMIT - 1.
    const banner = 'C'.repeat(MAX_TOOL_RESULT_CHARS - 12) + '😀'.repeat(50);
    const execute = jest.fn().mockResolvedValue({ banner });
    setResponse(name, 'http_probe', { host: 'target.example' });

    await providers[name]().discover(context, [tool('http_probe', execute)], 'system', 'user');

    const body = toolResultSent(name).split('... [tool result truncated')[0];
    expect(body).not.toMatch(/[\ud800-\udbff]$/);
  });
});

describe.each(names)('%s provider: tool results sent to the model lose hidden characters', (name) => {
  it('removes line separators, C1 controls and bidi/format characters from any tool result', async () => {
    const banner = 'Server:\u2028\u2029 ok\u0085\u009f \u202Eevil\u2066\u2069 a\u200Bb\u200Dc\uFEFFd\u00ADe';
    const execute = jest.fn().mockResolvedValue({ banner, 'k\u202Ey': 'v' });
    setResponse(name, 'http_probe', { host: 'target.example' });

    const result = await providers[name]().discover(context, [tool('http_probe', execute)], 'system', 'user');

    expect(toolResultSent(name)).toBe(JSON.stringify({ banner: 'Server: ok evil abcde', ky: 'v' }));
    // The session record is unchanged.
    expect(result.toolCalls[0]?.output.banner).toBe(banner);
  });

  it('keeps ordinary non-ASCII text and emoji', async () => {
    const execute = jest.fn().mockResolvedValue({ banner: 'Grüße 日本語 😀' });
    setResponse(name, 'http_probe', { host: 'target.example' });

    await providers[name]().discover(context, [tool('http_probe', execute)], 'system', 'user');

    expect(toolResultSent(name)).toBe(JSON.stringify({ banner: 'Grüße 日本語 😀' }));
  });

  it('strips before the cap, so hidden padding does not use up the limit', async () => {
    const execute = jest.fn().mockResolvedValue({ banner: '\u200B'.repeat(MAX_TOOL_RESULT_CHARS * 2) + 'tail' });
    setResponse(name, 'http_probe', { host: 'target.example' });

    await providers[name]().discover(context, [tool('http_probe', execute)], 'system', 'user');

    expect(toolResultSent(name)).toBe('{"banner":"tail"}');
  });
});
