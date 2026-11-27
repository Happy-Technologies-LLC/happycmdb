// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiClient } = vi.hoisted(() => ({ apiClient: { put: vi.fn() } }));
vi.mock('../../services/api', () => ({ apiClient }));

import { NotificationSettings } from './NotificationSettings';

describe('NotificationSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.put.mockResolvedValue({ data: { success: true } });
  });

  it('shows the defaults as checked and unchecked boxes and saves exactly them untouched', async () => {
    const user = userEvent.setup();
    render(<NotificationSettings />);
    expect(screen.getByRole('checkbox', { name: 'Email me when a job fails' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Email me when a job succeeds' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Email me when discovery completes' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Enable in-app notifications' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Digest Frequency' })).toHaveTextContent('Daily');

    await user.click(screen.getByRole('button', { name: 'Save Settings' }));

    expect(apiClient.put).toHaveBeenCalledExactlyOnceWith('/settings/notifications', {
      emailOnJobFailure: true,
      emailOnJobSuccess: false,
      emailOnDiscoveryCompletion: true,
      inAppNotifications: true,
      emailDigestFrequency: 'daily',
    });
    expect(await screen.findByText('Notification settings saved successfully')).toBeInTheDocument();
  });

  it('saves every toggle and the digest frequency as the user left them', async () => {
    const user = userEvent.setup();
    render(<NotificationSettings />);
    await user.click(screen.getByRole('checkbox', { name: 'Email me when a job fails' }));
    await user.click(screen.getByRole('checkbox', { name: 'Email me when a job succeeds' }));
    await user.click(screen.getByRole('checkbox', { name: 'Email me when discovery completes' }));
    await user.click(screen.getByRole('checkbox', { name: 'Enable in-app notifications' }));
    await user.click(screen.getByRole('combobox', { name: 'Digest Frequency' }));
    await user.click(screen.getByRole('option', { name: 'Weekly' }));
    await user.click(screen.getByRole('button', { name: 'Save Settings' }));

    expect(apiClient.put).toHaveBeenCalledExactlyOnceWith('/settings/notifications', {
      emailOnJobFailure: false,
      emailOnJobSuccess: true,
      emailOnDiscoveryCompletion: false,
      inAppNotifications: false,
      emailDigestFrequency: 'weekly',
    });
  });

  it('shows the server message when the save is refused, and no success notice', async () => {
    const user = userEvent.setup();
    apiClient.put.mockRejectedValue({ response: { status: 500, data: { message: 'Internal error' } } });
    render(<NotificationSettings />);
    await user.click(screen.getByRole('button', { name: 'Save Settings' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Internal error');
    expect(screen.queryByText('Notification settings saved successfully')).toBeNull();
  });
});
