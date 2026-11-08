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

describe('ApiService login', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the backend credential field names', async () => {
    request.post.mockResolvedValue({
      data: { data: { _accessToken: 'access', _refreshToken: 'refresh', _expiresIn: 3600 } },
    });

    await api.login({ username: 'admin', password: 'password123' });

    expect(request.post).toHaveBeenCalledWith('/auth/login', {
      username: 'admin',
      password: 'password123',
    });
  });
});

describe('ApiService changePassword (HAP-1285)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps this device signed in: the re-issued access token replaces the stored one', async () => {
    const before = `before-${crypto.randomUUID()}`;
    const reissued = `reissued-${crypto.randomUUID()}`;
    localStorage.setItem('auth_token', before);
    request.put.mockResolvedValue({ data: { success: true, data: { _accessToken: reissued, _expiresIn: 900 } } });
    const passwords = { currentPassword: crypto.randomUUID(), newPassword: crypto.randomUUID() };

    await api.changePassword(passwords);

    expect(request.put).toHaveBeenCalledWith('/auth/password', passwords);
    expect(localStorage.getItem('auth_token')).toBe(reissued);
  });
});
