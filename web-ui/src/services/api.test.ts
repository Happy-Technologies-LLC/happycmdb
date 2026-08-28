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
