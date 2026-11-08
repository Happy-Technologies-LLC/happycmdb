// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { request, apiClient } = vi.hoisted(() => {
  const request = {
    post: vi.fn(),
    get: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
  const apiClient = {
    ...request,
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  return { request, apiClient };
});

vi.mock('axios', () => ({
  default: { create: vi.fn(() => apiClient) },
}));

import { api } from './api';
import { getToken, setToken } from '../utils/token';

describe('ApiService login', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the backend credential field names and X-CMDB-Auth: 1, the only login that gets the refresh cookie (HAP-1211 F2)', async () => {
    request.post.mockResolvedValue({
      data: { data: { _accessToken: 'access', _expiresIn: 3600 } },
    });

    await api.login({ username: 'admin', password: 'password123' });

    expect(request.post).toHaveBeenCalledWith('/auth/login', {
      username: 'admin',
      password: 'password123',
    }, { headers: { 'X-CMDB-Auth': '1' } });
  });
});

describe('ApiService changePassword (HAP-1285, HAP-1211 H2)', () => {
  const before = `before-${crypto.randomUUID()}`;
  const passwords = { currentPassword: crypto.randomUUID(), newPassword: crypto.randomUUID() };
  beforeEach(() => {
    vi.clearAllMocks();
    setToken(before);
  });

  it('keeps this device signed in: the re-issued access token replaces the in-memory one, never Web Storage', async () => {
    const reissued = `reissued-${crypto.randomUUID()}`;
    request.put.mockResolvedValue({ data: { success: true, data: { _accessToken: reissued, _expiresIn: 900 } } });

    await api.changePassword(passwords);

    expect(request.put).toHaveBeenCalledWith('/auth/password', passwords);
    expect(getToken()).toBe(reissued);
    expect(localStorage.getItem('auth_token')).toBeNull();
  });

  it('a 200 without an access token fails and keeps the current token (never stores "undefined")', async () => {
    request.put.mockResolvedValue({ data: { success: true, data: {} } });

    await expect(api.changePassword(passwords)).rejects.toThrow();

    expect(getToken()).toBe(before);
  });
});
