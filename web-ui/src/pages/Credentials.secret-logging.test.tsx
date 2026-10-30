// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1210 S2a (P-3): a failed credential create or update never logs the typed secret or the bearer token.
import { inspect } from 'node:util';
import type { InternalAxiosRequestConfig } from 'axios';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Built at runtime from neutral parts so no fixture looks like a real value.
const MARK = ['h1210', 's2a', 'mark'].join('-');
const TOK = ['h1210', 's2a', 'tok'].join('-');

const { request, showToast } = vi.hoisted(() => ({
  request: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), patch: vi.fn() },
  showToast: vi.fn(),
}));
vi.mock('axios', async () => ({ ...(await vi.importActual<object>('axios')), default: { create: () => ({
  ...request, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
}) } }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('@happy-technologies/design-system', () => ({ Icon: () => null, Eyebrow: ({ children }: { children?: ReactNode }) => children }));

import { AxiosError, AxiosHeaders } from 'axios';
import { Credentials } from './Credentials';

const STORED = { id: 'cred-1', name: 'aws-main', protocol: 'aws_iam', scope: 'universal', credentials: {}, tags: [] };

// The rejection carries what the real client would: the bearer header and the request body in config.
const failWith500 = (method: string) => (url: string, body: unknown) => {
  const config = {
    method, url, headers: new AxiosHeaders({ Authorization: `Bearer ${TOK}` }), data: JSON.stringify(body),
  } as InternalAxiosRequestConfig;
  return Promise.reject(new AxiosError('Request failed with status code 500', 'ERR_BAD_RESPONSE', config, {},
    { status: 500, statusText: 'Internal Server Error', data: {}, headers: {}, config }));
};

const spies: MockInstance[] = [];
// Records any fetch; resolves so a side channel runs to completion instead of failing for an unrelated reason.
const fetchStub = vi.fn(async () => new Response(null, { status: 204 }));
let stderr: MockInstance;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchStub);
  request.get.mockImplementation((url: string) => Promise.resolve({ data: url.startsWith('/credentials?')
    ? { success: true, data: [{ ...STORED, created_at: '2026-10-01T00:00:00Z' }] }
    : { success: true, data: STORED } }));
  request.post.mockImplementation(failWith500('post'));
  request.put.mockImplementation(failWith500('put'));
  for (const level of ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir'] as const) {
    spies.push(vi.spyOn(console, level).mockImplementation(() => undefined));
  }
  stderr = vi.spyOn(process.stderr, 'write');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // No console level and no stderr write ever sees the marker or the token, in any argument, at any depth.
  const seen = [...spies.splice(0), stderr].map((spy) => {
    const text = inspect(spy.mock.calls, { depth: null, maxArrayLength: null, maxStringLength: null });
    spy.mockRestore();
    return text;
  }).join('\n');
  expect(seen).not.toContain(MARK);
  expect(seen).not.toContain(TOK);
  // The only network path is the mocked client; nothing reaches fetch.
  expect(fetchStub).not.toHaveBeenCalled();
});

const type = (label: RegExp, value: string): boolean => fireEvent.change(screen.getByLabelText(label), { target: { value } });

async function expectOnlyWrite(method: 'post' | 'put', path: string, label: string): Promise<void> {
  await waitFor(() => expect(showToast).toHaveBeenCalledWith('Request failed with status code 500', 'error'));
  const writes = { post: request.post.mock.calls, put: request.put.mock.calls, delete: request.delete.mock.calls, patch: request.patch.mock.calls };
  expect(Object.entries(writes).filter(([, calls]) => calls.length > 0).map(([name, calls]) => [name, calls.length])).toEqual([[method, 1]]);
  const [url, body] = writes[method][0] as [string, unknown];
  expect(url).toBe(path);
  expect(JSON.stringify(body)).toContain(MARK);
  expect((request.get.mock.calls as [string][]).every(([get]) => /^\/credentials(\?|\/cred-1$)/.test(get))).toBe(true);
  expect(console.error).toHaveBeenCalledWith(`[ERROR] ${label}`, { errorClass: 'AxiosError', status: 500 });
}

describe('Credentials secret logging (HAP-1210 S2a, T3)', () => {
  it('(a) a failed create logs neither the typed secret nor the token', async () => {
    render(<Credentials />);
    fireEvent.click(screen.getByRole('button', { name: /create credential/i }));
    type(/^name/i, 'aws-new');
    type(/access key id/i, `${MARK}-id`);
    type(/secret access key/i, MARK);
    fireEvent.click(screen.getByRole('button', { name: /save credential/i }));
    await expectOnlyWrite('post', '/credentials', 'Failed to create credential:');
  });

  it('(b) a failed update logs neither the typed secret nor the token', async () => {
    render(<Credentials />);
    fireEvent.click(await screen.findByTitle('Edit'));
    await screen.findByText('Edit Credential');
    type(/access key id/i, `${MARK}-id`);
    type(/secret access key/i, MARK);
    fireEvent.click(screen.getByRole('button', { name: /save credential/i }));
    await expectOnlyWrite('put', '/credentials/cred-1', 'Failed to update credential:');
  });
});
