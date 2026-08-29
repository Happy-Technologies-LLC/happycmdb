// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiClient } = vi.hoisted(() => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../services/api', () => ({ apiClient }));

import { ApiKeysManager } from './ApiKeysManager';

describe('ApiKeysManager', () => {
  const listedKey = {
    _id: 'key-1',
    _name: 'CI integration',
    _role: 'operator',
    _enabled: true,
    _createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    lastUsedAt: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockResolvedValue({ data: { success: true, data: [listedKey] } });
  });

  it('unwraps API key list responses without expecting persisted secrets or scopes', async () => {
    render(<ApiKeysManager />);

    expect(await screen.findByText('CI integration')).toBeTruthy();
    expect(screen.getByText('operator')).toBeTruthy();
    expect(screen.queryByText('Scopes')).toBeNull();
    expect(apiClient.get).toHaveBeenCalledWith('/auth/api-keys');
  });

  it('unwraps the generated API key secret and only sends supported fields', async () => {
    const user = userEvent.setup();
    apiClient.post.mockResolvedValue({
      data: {
        success: true,
        data: {
          _apiKey: 'hcmdb_secret_key',
          _id: 'key-2',
          _name: 'Automation',
          expiresAt: null,
        },
      },
    });

    render(<ApiKeysManager />);
    await screen.findByText('CI integration');
    await user.click(screen.getByRole('button', { name: /generate new key/i }));
    await user.type(screen.getByLabelText(/key name/i), 'Automation');
    await user.click(screen.getByRole('button', { name: /^generate$/i }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/auth/api-key', { name: 'Automation' });
    });
    expect(await screen.findByText('hcmdb_secret_key')).toBeTruthy();
  });

  it('revokes a listed key through its singular API key route', async () => {
    const user = userEvent.setup();
    apiClient.delete.mockResolvedValue({ data: { success: true } });

    render(<ApiKeysManager />);
    await screen.findByText('CI integration');
    await user.click(screen.getByRole('button', { name: /revoke ci integration/i }));
    await user.click(screen.getByRole('button', { name: /^revoke$/i }));

    await waitFor(() => {
      expect(apiClient.delete).toHaveBeenCalledWith('/auth/api-key/key-1');
    });
  });
});
