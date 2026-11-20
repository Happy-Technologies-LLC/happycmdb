// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import type { Request, Response } from 'express';
import { logger } from '@cmdb/common';
import type { ConfigSchema } from '@cmdb/common';
import { AuthMiddleware } from '../auth.middleware';
import { AuthFailureError, type AuthService } from '../../auth/auth.service';

const user = { _userId: 'u1', _username: 'owner', _role: 'operator', _type: 'access', _organizationId: '11111111-1111-4111-8111-111111111111' };
const keyUser = { ...user, _userId: 'key-user' };
const verifyToken = jest.fn();
const verifyApiKey = jest.fn();
const authService = { verifyToken, verifyApiKey } as unknown as AuthService;

const build = (apiKeys: Record<string, unknown>) =>
  new AuthMiddleware(authService, { apiKeys } as ConfigSchema['auth']);

function run(handler: (req: never, res: never, next: never) => Promise<void>, headers: Record<string, string>) {
  const req = { headers } as unknown as Request & { user?: unknown; credentialType?: string };
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res = { status } as unknown as Response;
  const next = jest.fn();
  return handler(req as never, res as never, next as never).then(() => ({ req, status, json, next }));
}

let warn: jest.SpyInstance;
beforeEach(() => {
  // jest.config.unit.js sets resetMocks, so implementations are installed per test.
  verifyToken.mockImplementation(async (token: string) => {
    if (token === 'valid') return user;
    throw new Error('bad token');
  });
  verifyApiKey.mockImplementation(async (key: string) => {
    if (key === 'valid') return keyUser;
    throw new Error('bad key');
  });
  warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('AuthMiddleware with apiKeys.enabled === false', () => {
  const disabled = () => build({ headerName: 'X-API-Key', enabled: false });

  it('authenticate(): a key-only request gets the same 401 body as no credentials and never reaches verifyApiKey', async () => {
    const mw = disabled();
    const none = await run(mw.authenticate() as never, {});
    const keyOnly = await run(mw.authenticate() as never, { 'x-api-key': 'valid' });

    expect(keyOnly.status).toHaveBeenCalledWith(401);
    expect(keyOnly.json.mock.calls).toEqual(none.json.mock.calls);
    expect(keyOnly.json.mock.calls[0][0]).toEqual({ _error: 'Unauthorized', _message: 'Authentication failed' });
    expect(keyOnly.next).not.toHaveBeenCalled();
    expect(keyOnly.req.user).toBeUndefined();
    expect(verifyApiKey).not.toHaveBeenCalled();
  });

  it('optionalAuthenticate(): a key-only request leaves user unset, calls next once, never reaches verifyApiKey', async () => {
    const result = await run(disabled().optionalAuthenticate() as never, { 'x-api-key': 'valid' });

    expect(result.req.user).toBeUndefined();
    expect(result.next).toHaveBeenCalledTimes(1);
    expect(verifyApiKey).not.toHaveBeenCalled();
  });

  it('a valid bearer token still authenticates when a key header is sent alongside it', async () => {
    const mw = disabled();
    const strict = await run(mw.authenticate() as never, { authorization: 'Bearer valid', 'x-api-key': 'valid' });
    const optional = await run(mw.optionalAuthenticate() as never, { authorization: 'Bearer valid', 'x-api-key': 'valid' });

    for (const result of [strict, optional]) {
      expect(result.req.user).toEqual(user);
      expect(result.req.credentialType).toBe('jwt');
      expect(result.next).toHaveBeenCalledTimes(1);
    }
    expect(verifyApiKey).not.toHaveBeenCalled();
  });

  it('authenticate(): a key-only request logs only the api_keys_disabled reason, never the header value', async () => {
    const secret = 'sk-secret-key-value-1234';
    const result = await run(disabled().authenticate() as never, { 'x-api-key': secret });

    expect(result.status).toHaveBeenCalledWith(401);
    expect(result.json.mock.calls[0][0]).toEqual({ _error: 'Unauthorized', _message: 'Authentication failed' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ credentialType: 'api-key', reason: 'api_keys_disabled' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  });

  it('authenticate(): no credentials at all still logs none/invalid', async () => {
    await run(disabled().authenticate() as never, {});

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ credentialType: 'none', reason: 'invalid' });
  });

  it('optionalAuthenticate(): a key-only request logs api_keys_disabled once, sets no user and calls next', async () => {
    const secret = 'sk-secret-key-value-1234';
    const result = await run(disabled().optionalAuthenticate() as never, { 'x-api-key': secret });

    expect(result.req.user).toBeUndefined();
    expect(result.next).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ credentialType: 'api-key', reason: 'api_keys_disabled' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  });

  it('a bearer token plus a key header: the token decides and nothing is logged', async () => {
    const mw = disabled();
    await run(mw.authenticate() as never, { authorization: 'Bearer valid', 'x-api-key': 'valid' });
    await run(mw.optionalAuthenticate() as never, { authorization: 'Bearer valid', 'x-api-key': 'valid' });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('AuthMiddleware with apiKeys.enabled === true and a bad key', () => {
  it('authenticate() keeps the invalid reason when verifyApiKey rejects the key', async () => {
    verifyApiKey.mockImplementation(async () => { throw new AuthFailureError('invalid'); });
    const result = await run(build({ headerName: 'X-API-Key', enabled: true }).authenticate() as never, { 'x-api-key': 'bad' });

    expect(result.status).toHaveBeenCalledWith(401);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ credentialType: 'api-key', reason: 'invalid' });
  });
});

describe.each([
  ['enabled: true', { headerName: 'X-API-Key', enabled: true }],
  ['enabled absent', { headerName: 'X-API-Key' }],
])('AuthMiddleware with %s', (_label, apiKeys) => {
  it('authenticate() verifies a key header and authenticates', async () => {
    const result = await run(build(apiKeys).authenticate() as never, { 'x-api-key': 'valid' });

    expect(verifyApiKey).toHaveBeenCalledWith('valid');
    expect(result.req.user).toEqual(keyUser);
    expect(result.req.credentialType).toBe('api-key');
    expect(result.next).toHaveBeenCalledTimes(1);
  });

  it('optionalAuthenticate() verifies a key header and sets the user', async () => {
    const result = await run(build(apiKeys).optionalAuthenticate() as never, { 'x-api-key': 'valid' });

    expect(verifyApiKey).toHaveBeenCalledWith('valid');
    expect(result.req.user).toEqual(keyUser);
    expect(result.next).toHaveBeenCalledTimes(1);
  });
});
