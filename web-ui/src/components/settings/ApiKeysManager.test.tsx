// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
import { secretMarker } from '@/tests/utils/secretDom';

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

describe('ApiKeysManager states', () => {
  const key = {
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
    apiClient.get.mockResolvedValue({ data: { success: true, data: [key] } });
  });

  it('shows a loading status while the list is in flight, not the empty message', async () => {
    apiClient.get.mockReturnValue(new Promise(() => undefined));
    render(<ApiKeysManager />);

    expect(await screen.findByRole('status')).toHaveTextContent('Loading API keys');
    expect(screen.queryByText('No API keys yet. Generate one to get started.')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the empty message and keeps the generate control when there are no keys', async () => {
    apiClient.get.mockResolvedValue({ data: { success: true, data: [] } });
    render(<ApiKeysManager />);

    expect(await screen.findByText('No API keys yet. Generate one to get started.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /generate new key/i })).toBeEnabled();
  });

  it('shows the failure with a retry that reads again, never a blank list or the empty message', async () => {
    const user = userEvent.setup();
    apiClient.get
      .mockRejectedValueOnce({ response: { status: 500, data: { message: 'Key store unavailable' } } })
      .mockResolvedValueOnce({ data: { success: true, data: [key] } });
    render(<ApiKeysManager />);

    expect(await screen.findByText('Could not load API keys')).toBeInTheDocument();
    expect(screen.getByText('Key store unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No API keys yet. Generate one to get started.')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('CI integration')).toBeInTheDocument();
    expect(screen.queryByText('Could not load API keys')).toBeNull();
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('says it is not permitted on a 403, with the server reason, no spinner and no retry', async () => {
    apiClient.get.mockRejectedValue({ response: { status: 403, data: { _error: 'Forbidden', _message: 'A signed-in session is required' } } });
    render(<ApiKeysManager />);

    expect(await screen.findByText('No access to API keys')).toBeInTheDocument();
    expect(screen.getByText('A signed-in session is required')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows a key that was never used as "Never", not as a date', async () => {
    render(<ApiKeysManager />);

    const row = (await screen.findByText('CI integration')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Never')).toBeInTheDocument();
    expect(row.textContent).not.toMatch(/1970|Invalid Date/);
  });

  it('asks for confirmation before revoking and revokes nothing when cancelled', async () => {
    const user = userEvent.setup();
    render(<ApiKeysManager />);
    await screen.findByText('CI integration');

    await user.click(screen.getByRole('button', { name: /revoke ci integration/i }));
    expect(screen.getByRole('dialog', { name: 'Revoke API Key' })).toBeInTheDocument();
    expect(apiClient.delete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(apiClient.delete).not.toHaveBeenCalled();
  });

  it('shows a new key once, in the dialog text only, and never in an attribute', async () => {
    const user = userEvent.setup();
    const generated = secretMarker('apikey');
    apiClient.post.mockResolvedValue({
      data: { success: true, data: { _apiKey: generated, _id: 'key-2', _name: 'Automation', expiresAt: null } },
    });
    render(<ApiKeysManager />);
    await screen.findByText('CI integration');
    await user.click(screen.getByRole('button', { name: /generate new key/i }));
    await user.type(screen.getByLabelText(/key name/i), 'Automation');
    await user.click(screen.getByRole('button', { name: /^generate$/i }));

    const shown = await screen.findByText(generated);
    expect(shown.closest('[role="dialog"]')).not.toBeNull();
    expect(screen.getByText(/you won't be able to see it again/i)).toBeInTheDocument();
    const carriers = Array.from(document.body.querySelectorAll('*')).filter((el) =>
      Array.from(el.attributes).some((attr) => attr.value.includes(generated) || attr.name.includes(generated)),
    );
    expect(carriers).toEqual([]);

    await user.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(screen.queryByText(generated)).toBeNull();
    await user.click(screen.getByRole('button', { name: /generate new key/i }));
    expect(screen.queryByText(generated)).toBeNull();
  });
});
