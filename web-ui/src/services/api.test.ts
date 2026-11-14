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

describe('ApiService user mapping (HAP-1911)', () => {
  beforeEach(() => vi.clearAllMocks());
  const base = { userId: 'u-1', username: 'alice', email: 'alice@example.com', role: 'operator' };

  it('maps the server platformAdmin and organizationId on /auth/me and /auth/profile', async () => {
    const data = { ...base, platformAdmin: true, organizationId: 'org-acme' };
    request.get.mockResolvedValue({ data: { data } });
    request.put.mockResolvedValue({ data: { data } });

    for (const user of [await api.getCurrentUser(), await api.updateProfile({ name: 'Alice' })]) {
      expect(user).toMatchObject({ platform_admin: true, organization_id: 'org-acme' });
    }
  });

  it('an older server that sends neither field reads as no platform authority and no organization', async () => {
    request.get.mockResolvedValue({ data: { data: base } });

    expect(await api.getCurrentUser()).toMatchObject({ platform_admin: false, organization_id: null });
  });

  it('only a literal true is platform authority; a null organization stays null', async () => {
    for (const platformAdmin of ['true', 1, 'yes', null]) {
      request.get.mockResolvedValue({ data: { data: { ...base, platformAdmin, organizationId: null } } });
      expect(await api.getCurrentUser()).toMatchObject({ platform_admin: false, organization_id: null });
    }
  });
});
