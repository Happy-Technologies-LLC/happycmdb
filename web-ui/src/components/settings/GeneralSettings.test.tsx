// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiClient } = vi.hoisted(() => ({ apiClient: { put: vi.fn() } }));
vi.mock('../../services/api', () => ({ apiClient }));

import { GeneralSettings } from './GeneralSettings';

const pick = async (user: ReturnType<typeof userEvent.setup>, field: string, option: string) => {
  await user.click(screen.getByRole('combobox', { name: field }));
  await user.click(screen.getByRole('option', { name: option }));
};

describe('GeneralSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.put.mockResolvedValue({ data: { success: true } });
  });

  it('offers each preference with its default and saves exactly the defaults untouched', async () => {
    const user = userEvent.setup();
    render(<GeneralSettings />);
    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveTextContent('English');
    expect(screen.getByRole('combobox', { name: 'Timezone' })).toHaveTextContent('UTC');
    expect(screen.getByRole('combobox', { name: 'Date Format' })).toHaveTextContent('MM/DD/YYYY');
    expect(screen.getByRole('combobox', { name: 'Default Page' })).toHaveTextContent('Dashboard');

    await user.click(screen.getByRole('button', { name: 'Save Settings' }));

    expect(apiClient.put).toHaveBeenCalledExactlyOnceWith('/settings', {
      language: 'en',
      timezone: 'UTC',
      dateFormat: 'MM/DD/YYYY',
      defaultPage: '/dashboard',
    });
    expect(await screen.findByText('Settings saved successfully')).toBeInTheDocument();
  });

  it('saves the chosen option values, not their labels', async () => {
    const user = userEvent.setup();
    render(<GeneralSettings />);
    await pick(user, 'Language', 'French');
    await pick(user, 'Timezone', 'Europe/Paris');
    await pick(user, 'Date Format', 'YYYY-MM-DD');
    await pick(user, 'Default Page', 'Estate graph');
    await user.click(screen.getByRole('button', { name: 'Save Settings' }));

    expect(apiClient.put).toHaveBeenCalledExactlyOnceWith('/settings', {
      language: 'fr',
      timezone: 'Europe/Paris',
      dateFormat: 'YYYY-MM-DD',
      defaultPage: '/?view=graph',
    });
  });

  it('shows the server message when the save is refused, and no success notice', async () => {
    const user = userEvent.setup();
    apiClient.put.mockRejectedValue({ response: { status: 400, data: { message: 'Unsupported timezone' } } });
    render(<GeneralSettings />);
    await user.click(screen.getByRole('button', { name: 'Save Settings' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Unsupported timezone');
    expect(screen.queryByText('Settings saved successfully')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save Settings' })).toBeEnabled();
  });

  it('disables the save control while the save is in flight', async () => {
    const user = userEvent.setup();
    apiClient.put.mockReturnValue(new Promise(() => undefined));
    render(<GeneralSettings />);
    await user.click(screen.getByRole('button', { name: 'Save Settings' }));

    expect(await screen.findByRole('button', { name: 'Saving...' })).toBeDisabled();
  });
});
