// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { domLeaks, secretMarker } from '@/tests/utils/secretDom';

const { apiClient, api, session } = vi.hoisted(() => ({
  apiClient: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
  api: { updateProfile: vi.fn(), changePassword: vi.fn(), revokeOtherSessions: vi.fn(), deleteAccount: vi.fn() },
  session: { role: 'admin' as string },
}));

vi.mock('../services/api', () => ({ apiClient, api }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { full_name: 'Alice Example', email: 'alice@example.com', role: session.role },
    hasRole: (roles: string[]) => roles.includes(session.role),
    refreshUser: vi.fn(),
    logout: vi.fn(),
  }),
}));

import { Settings } from './Settings';
import { DiscoverySettings } from '../components/settings/DiscoverySettings';
import { GeneralSettings } from '../components/settings/GeneralSettings';
import { UserProfile } from '../components/settings/UserProfile';

function Where() {
  const { search } = useLocation();
  return <span data-testid="search">{search}</span>;
}

const mount = (tab?: string) =>
  render(
    <MemoryRouter initialEntries={[tab ? `/settings?tab=${tab}` : '/settings']}>
      <Settings />
      <Where />
    </MemoryRouter>,
  );

const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  session.role = 'admin';
  apiClient.get.mockResolvedValue({ data: { databases: [], success: true, data: [] } });
  apiClient.put.mockResolvedValue({ data: { success: true } });
});

describe('Settings tabs', () => {
  it('lists the six tabs in order for an administrator, with General open by default', () => {
    mount();
    expect(tabNames()).toEqual(['General', 'Discovery', 'Notifications', 'Profile', 'API Keys', 'Database']);
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
  });

  it.each(['operator', 'viewer'])('offers no Database tab to a %s and never reads the database status', async (role) => {
    session.role = role;
    mount('database');
    expect(tabNames()).toEqual(['General', 'Discovery', 'Notifications', 'Profile', 'API Keys']);
    expect(screen.queryByText('Database Settings')).toBeNull();
    expect(apiClient.get).not.toHaveBeenCalledWith('/settings/database');
  });

  it('opens a tab on click, records it in the URL, and reads only for the tab that is open', async () => {
    const user = userEvent.setup();
    mount();
    expect(apiClient.get).not.toHaveBeenCalled();

    await user.click(screen.getByRole('tab', { name: 'Database' }));

    expect(screen.getByTestId('search')).toHaveTextContent('?tab=database');
    expect(await screen.findByText('No database status available.')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledExactlyOnceWith('/settings/database');
    expect(screen.queryByText('General Settings')).toBeNull();
  });
});

describe('Settings write gating', () => {
  it.each([
    ['general', 'General Settings', 'Save Settings'],
    ['discovery', 'Discovery Settings', 'Save'],
    ['notifications', 'Notification Settings', 'Save Settings'],
  ])('shows an operator the %s form with its save control', (tab, heading, save) => {
    session.role = 'operator';
    mount(tab);
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    if (tab === 'discovery') fireEvent.click(screen.getByRole('button', { name: 'AWS' }));
    expect(screen.getAllByRole('button', { name: save }).length).toBeGreaterThan(0);
  });

  it.each([
    ['general', 'General Settings'],
    ['discovery', 'Discovery Settings'],
    ['notifications', 'Notification Settings'],
  ])('shows a viewer "not permitted" instead of the %s form, with no field and no save control', (tab, heading) => {
    session.role = 'viewer';
    mount(tab);
    expect(screen.getByText('Not permitted')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: heading })).toBeNull();
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(apiClient.put).not.toHaveBeenCalled();
  });

  it('keeps the viewer\'s own profile and API keys reachable', async () => {
    session.role = 'viewer';
    mount('profile');
    expect(screen.getByRole('button', { name: 'Update Profile' })).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('tab', { name: 'API Keys' }));
    expect(await screen.findByText('No API keys yet. Generate one to get started.')).toBeInTheDocument();
  });
});

describe('secret fields on the design system (HAP-1213 DOM contract)', () => {
  it('keeps every typed secret out of the DOM with a design-system Select listbox and Dialog open', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <GeneralSettings />
        <DiscoverySettings />
        <UserProfile />
      </MemoryRouter>,
    );
    for (const section of ['AWS', 'Azure', 'Google Cloud Platform', 'SSH']) {
      fireEvent.click(screen.getByRole('button', { name: section }));
    }
    // Every secret field: provider keys and credentials, and the three password fields plus the step-up password.
    const labels = [
      'Access Key ID',
      'Secret Access Key',
      'Client Secret',
      'Service Account Credentials (JSON)',
      'Private Key',
      'Current Password',
      'New Password',
      'Confirm New Password',
      'Current password to confirm',
    ];
    const typed = labels.map((label) => {
      const marker = secretMarker('settings');
      fireEvent.change(screen.getByLabelText(label), { target: { value: marker } });
      return { label, marker };
    });

    await user.click(screen.getByRole('combobox', { name: 'Language' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete Account' }));
    expect(screen.getByRole('dialog', { name: 'Delete Account' })).toBeInTheDocument();

    for (const { label, marker } of typed) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(marker);
      expect({ label, leaks: domLeaks(marker) }).toEqual({ label, leaks: [] });
    }
    expect(within(screen.getByRole('dialog')).queryByRole('textbox')).toBeNull();
  });
});

describe('discovery settings payloads', () => {
  it('saves each provider\'s credentials object exactly as typed, to that provider\'s route', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <DiscoverySettings />
      </MemoryRouter>,
    );
    const fill: Array<[string, Array<[string, string]>]> = [
      ['AWS', [['Access Key ID', 'AKIA-test'], ['Secret Access Key', 'aws-secret'], ['Region', 'eu-west-1']]],
      ['Azure', [['Subscription ID', 'sub-1'], ['Tenant ID', 'tenant-1'], ['Client ID', 'client-1'], ['Client Secret', 'az-secret']]],
      ['Google Cloud Platform', [['Project ID', 'proj-1'], ['Service Account Credentials (JSON)', '{"k":1}']]],
      ['SSH', [['Username', 'root'], ['Private Key', 'ssh-key']]],
    ];
    for (const [section, fields] of fill) {
      await user.click(screen.getByRole('button', { name: section }));
      const region = screen.getByRole('region', { name: section });
      for (const [label, value] of fields) {
        const field = within(region).getByLabelText(label);
        fireEvent.change(field, { target: { value } });
      }
      await user.click(within(region).getByRole('button', { name: 'Save' }));
    }

    expect(apiClient.put.mock.calls).toEqual([
      ['/settings/discovery/aws', { credentials: { accessKeyId: 'AKIA-test', secretAccessKey: 'aws-secret', region: 'eu-west-1' } }],
      ['/settings/discovery/azure', { credentials: { subscriptionId: 'sub-1', tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'az-secret' } }],
      ['/settings/discovery/gcp', { credentials: { projectId: 'proj-1', credentials: '{"k":1}' } }],
      ['/settings/discovery/ssh', { credentials: { username: 'root', privateKey: 'ssh-key' } }],
    ]);
    expect(await screen.findAllByText('Credentials saved successfully')).toHaveLength(4);
  });

  it('shows the server message in that provider\'s section when its save is refused', async () => {
    const user = userEvent.setup();
    apiClient.put.mockRejectedValue({ response: { status: 400, data: { message: 'Unsupported region' } } });
    render(
      <MemoryRouter>
        <DiscoverySettings />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'AWS' }));
    await user.click(within(screen.getByRole('region', { name: 'AWS' })).getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Unsupported region');
    expect(screen.queryByText('Credentials saved successfully')).toBeNull();
  });
});
