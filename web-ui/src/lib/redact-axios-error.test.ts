// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { inspect } from 'node:util';
import axios, { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redactAxiosError } from './redact-axios-error';

// Runtime-built, scanner-neutral token and body marker (HAP-1210 S3).
const TOK = `H1210S3TOK${Date.now()}`;
const MARK = `H1210S3MARK${Date.now()}`;
const FULL = { depth: null, maxArrayLength: null, maxStringLength: null } as const;
const leaks = (text = '') => text.includes(TOK) || text.includes(MARK);
const loc = { href: '' };
let status = 500;

// Mocked adapter, no network: settles like axios's xhr adapter (error.config === response.config, request = an XHR).
axios.defaults.adapter = async (config) => {
  const request = new XMLHttpRequest();
  request.open(String(config.method), String(config.url));
  request.setRequestHeader('Authorization', String(config.headers.Authorization));
  const response = { data: { status }, status, statusText: '', headers: {}, config, request };
  if (status < 400) return response;
  throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE', config, request, response);
};
// Dynamic on purpose: axios.create copies defaults, so the clients must be created after the adapter is set.
const { api } = await import('../services/api');
const { apiClient } = await import('./api-client');
const { credentialService } = await import('../services/credential.service');
const { ciService } = await import('../services/ci.service');

const rejection = (call: () => Promise<unknown>) => call().then(() => { throw new Error('no rejection'); }, (e: AxiosError) => e);

beforeEach(() => {
  status = 500;
  loc.href = '';
  localStorage.setItem('auth_token', TOK);
  vi.stubGlobal('location', loc);
});

describe.each([
  ['services/api', 'put', '/auth/profile', () => api.updateProfile({ name: MARK })],
  ['lib/api-client', 'post', '/business-services', () => apiClient.post('/business-services', { name: MARK })],
  ['services/credential.service', 'post', '/credentials', () => credentialService.createCredential({ name: MARK } as never)],
  ['services/ci.service', 'post', '/cis', () => ciService.createCI({ name: MARK } as never)],
])('%s rejected errors (HAP-1210 S3)', (_client, method, url, call) => {
  it('a 500 keeps url and method but carries no token or body in config, JSON, inspect or toJSON', async () => {
    const err = await rejection(call);
    expect(err.response?.status).toBe(500);
    expect(err.response?.config).toBe(err.config);
    expect(err.config).toMatchObject({ url, method, data: undefined });
    expect(err.config?.headers.Authorization).toBeUndefined();
    expect([JSON.stringify(err), inspect(err, FULL), JSON.stringify(err.toJSON?.())].filter(leaks)).toEqual([]);
  });
  it('a non-login 401 still clears the token and redirects to /login', async () => {
    status = 401;
    await rejection(call);
    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(loc.href).toBe('/login');
  });
});

describe('redactAxiosError', () => {
  it('services/api: a login 401 does not redirect; a success passes through', async () => {
    status = 401;
    await rejection(() => api.login({ username: MARK } as never));
    expect(loc.href).toBe('');
    expect(localStorage.getItem('auth_token')).toBe(TOK);
    status = 200;
    await expect(apiClient.post('/x', { name: MARK })).resolves.toEqual({ status: 200 });
  });

  it('redacts response.config too when it is a different object, and never throws', () => {
    const config = { url: '/x', method: 'post', headers: { Authorization: TOK }, data: MARK };
    const response = { status: 500, config: { ...config, headers: { ...config.headers } } };
    const err = new AxiosError('failed', 'ERR_BAD_RESPONSE', { ...config, headers: new AxiosHeaders(config.headers) }, null, response as never);
    expect(redactAxiosError(err)).toBe(err);
    expect(err.response?.config.url).toBe('/x');
    expect(leaks(inspect(err, FULL))).toBe(false);
    const frozen = Object.freeze({ config: Object.freeze({ data: MARK }) });
    expect(redactAxiosError(frozen)).toBe(frozen);
  });
});
