// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// Connector catalog read-only discovery and deployment-only lifecycle presentation.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { ForbiddenHost } from '@/components/layout/ForbiddenHost';
import { attachSession } from '@/lib/session';
import { UNKNOWN_VALUE } from '@/api/connectors';

const { connectorService } = vi.hoisted(() => ({
  connectorService: {
    getConnectorRegistry: vi.fn(),
    getInstalledConnectors: vi.fn(),
  },
}));

vi.mock('@/services/connector.service', () => ({
  default: connectorService,
  __esModule: true,
}));

import ConnectorCatalog from './ConnectorCatalog';

const REGISTRY_ITEM = {
  connectorType: 'c10fc-servicenow',
  category: 'CONNECTOR',
  name: 'ServiceNow',
  description: 'Bi-directional ServiceNow CMDB sync',
  verified: true,
  latestVersion: '2.0.0',
  versions: [
    { version: '2.0.0', releasedAt: '2026-08-01T00:00:00Z', downloadUrl: 'x', checksum: 'x', sizeBytes: 1, breakingChanges: false, changelog: '' },
  ],
  author: 'Happy Technologies',
  homepage: '',
  repository: '',
  license: 'proprietary',
  downloads: 100,
  rating: 4.5,
  tags: ['itsm'],
  metadata: {},
};

function renderCatalog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <MemoryRouter initialEntries={['/connectors/catalog']}>
      <QueryClientProvider client={queryClient}>
        <ConnectorCatalog />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe('ConnectorCatalog page (F-015)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectorService.getConnectorRegistry.mockResolvedValue([REGISTRY_ITEM]);
    connectorService.getInstalledConnectors.mockResolvedValue([]);
  });

  it('search filters the connector list by name', async () => {
    const user = userEvent.setup();
    renderCatalog();
    await screen.findByText('ServiceNow');

    const search = screen.getByPlaceholderText(/Search connectors/i);
    await user.type(search, 'nonexistent-xyz');

    await waitFor(() => {
      expect(screen.queryByText('ServiceNow')).not.toBeInTheDocument();
    });
  });

  it('shows deployment-only availability without exposing application install controls', async () => {
    const user = userEvent.setup();
    renderCatalog();
    await screen.findByText('ServiceNow');
    expect(screen.getByText('Available for deployment')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(install|update|uninstall)/i })).not.toBeInTheDocument();
    await user.click(screen.getByText('ServiceNow'));
    expect(screen.getByText(/Install and update connector code through deployment packaging/i))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(install|update|uninstall)/i })).not.toBeInTheDocument();
  });
});

// HAP-1922 S8j: read states, honest figures, and the DS controls.
describe('ConnectorCatalog read states and controls', () => {
  const ZETA = { ...REGISTRY_ITEM, connectorType: 'zeta', name: 'Zeta', description: 'Zeta sync', downloads: 500, rating: 3, verified: false, tags: ['cloud'] };
  const ALPHA = { ...REGISTRY_ITEM, connectorType: 'alpha', name: 'Alpha', description: 'Alpha sync', downloads: 100, rating: 5, verified: true };
  const INSTALLED_ALPHA = { connectorType: 'alpha', installedVersion: '1.0.0' };

  const tile = (label: string) => {
    const labelEl = screen.getAllByText(label).find((el) => el.parentElement?.querySelector('[data-metric-value]'));
    return within(labelEl!.parentElement as HTMLElement);
  };
  const order = () => screen.getAllByRole('button', { name: /^(Zeta|Alpha)$/ }).map((b) => b.textContent);

  function renderWithShell() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(
      <MemoryRouter initialEntries={['/connectors/catalog']}>
        <QueryClientProvider client={queryClient}>
          <ForbiddenHost />
          <ConnectorCatalog />
        </QueryClientProvider>
      </MemoryRouter>
    );
  }

  /** The real session client (its 403 interceptor reports to ForbiddenHost) answering with a refusal. */
  function refuseReads() {
    const client = axios.create({
      adapter: async (cfg: InternalAxiosRequestConfig) => {
        const response = {
          data: { _error: 'Forbidden', _message: "Permission 'read' required" },
          status: 403, statusText: '', headers: {}, config: cfg, request: {},
        };
        throw new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', cfg, {}, response);
      },
    });
    attachSession(client);
    connectorService.getConnectorRegistry.mockImplementation(() => client.get('/connectors/registry'));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    connectorService.getConnectorRegistry.mockResolvedValue([ZETA, ALPHA]);
    connectorService.getInstalledConnectors.mockResolvedValue([INSTALLED_ALPHA]);
  });

  it('counts the registry in its figures: available, installed, updates and verified', async () => {
    renderWithShell();
    await screen.findByText('Zeta');

    expect(tile('Available').getByText('2')).toBeVisible();
    expect(tile('Installed').getByText('1')).toBeVisible();
    expect(tile('Updates Available').getByText('1')).toBeVisible();
    expect(tile('Verified').getByText('1')).toBeVisible();
    expect(screen.getByText('Showing 2 connectors')).toBeVisible();
    expect(screen.getByText('Installed (v1.0.0)')).toBeVisible();
  });

  it('shows a loading state, not an empty or error one, while the registry is in flight', async () => {
    connectorService.getConnectorRegistry.mockReturnValue(new Promise(() => undefined));
    renderWithShell();

    expect(await screen.findByText('Loading connector catalog…')).toBeVisible();
    expect(screen.queryByText('No connectors found')).not.toBeInTheDocument();
    expect(screen.queryByText('Could not load connector catalog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Connector Catalog' })).toBeVisible();
  });

  it('says so when the registry is empty', async () => {
    connectorService.getConnectorRegistry.mockResolvedValue([]);
    renderWithShell();

    expect(await screen.findByText('No connectors found')).toBeVisible();
    expect(screen.getByText('Showing 0 connectors')).toBeVisible();
  });

  it('shows a visible, retryable error for a failed registry read, with unavailable figures, never zeros', async () => {
    const user = userEvent.setup();
    connectorService.getConnectorRegistry.mockRejectedValue(new Error('registry exploded'));
    renderWithShell();

    expect(await screen.findByText('Could not load connector catalog')).toBeVisible();
    expect(screen.getByText('registry exploded')).toBeVisible();
    expect(tile('Available').getByText(UNKNOWN_VALUE)).toBeVisible();
    expect(tile('Updates Available').getByText(UNKNOWN_VALUE)).toBeVisible();
    expect(tile('Verified').getByText(UNKNOWN_VALUE)).toBeVisible();

    connectorService.getConnectorRegistry.mockResolvedValue([ZETA, ALPHA]);
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Zeta')).toBeVisible();
    expect(screen.queryByText('Could not load connector catalog')).not.toBeInTheDocument();
  });

  it('shows its own not-permitted state on a 403 while the shell banner shows the server reason, with no retry', async () => {
    refuseReads();
    renderWithShell();

    expect(await screen.findByText('No access to connector catalog')).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent("Access denied. Permission 'read' required");
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByText('Loading connector catalog…')).not.toBeInTheDocument();
  });

  it('shows Installed and Updates as unavailable, not zero, when only the installed read fails', async () => {
    connectorService.getInstalledConnectors.mockRejectedValue(new Error('installed exploded'));
    renderWithShell();
    await screen.findByText('Zeta');

    await waitFor(() => expect(tile('Installed').getByText(UNKNOWN_VALUE)).toBeVisible());
    expect(tile('Updates Available').getByText(UNKNOWN_VALUE)).toBeVisible();
    expect(tile('Available').getByText('2')).toBeVisible();
    expect(screen.getAllByText('Available for deployment')).toHaveLength(2);
  });

  it('re-sorts the list from the sort control', async () => {
    const user = userEvent.setup();
    renderWithShell();
    await screen.findByText('Zeta');
    expect(order()).toEqual(['Zeta', 'Alpha']);

    await user.click(screen.getByRole('combobox', { name: 'Sort connectors' }));
    await user.click(screen.getByRole('option', { name: 'Name (A-Z)' }));

    expect(order()).toEqual(['Alpha', 'Zeta']);
  });

  it('queries the registry with the chosen filters, shows them as removable chips, and Clear All resets them', async () => {
    const user = userEvent.setup();
    renderWithShell();
    await screen.findByText('Zeta');
    expect(connectorService.getConnectorRegistry).toHaveBeenLastCalledWith({ tags: undefined, verifiedOnly: undefined });

    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Verified Only' }));

    await waitFor(() => expect(connectorService.getConnectorRegistry).toHaveBeenLastCalledWith({ tags: undefined, verifiedOnly: true }));
    expect(screen.getByRole('button', { name: 'Remove Verified Only filter' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Clear All' }));

    await waitFor(() => expect(connectorService.getConnectorRegistry).toHaveBeenLastCalledWith({ tags: undefined, verifiedOnly: undefined }));
    expect(screen.queryByRole('button', { name: 'Remove Verified Only filter' })).not.toBeInTheDocument();
  });

  it('opens a connector detail, closes it on Escape and returns focus to the control that opened it', async () => {
    const user = userEvent.setup();
    renderWithShell();
    const trigger = await screen.findByRole('button', { name: 'Zeta' });

    await user.click(trigger);
    expect(await screen.findByRole('dialog', { name: 'Zeta' })).toBeVisible();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('offers no write control at all: browse, filter and open details only', async () => {
    renderWithShell();
    await screen.findByText('Zeta');

    const names = screen.getAllByRole('button').map((b) => b.textContent || b.getAttribute('aria-label') || '');
    expect(names.filter((n) => /\b(install|update|uninstall|deploy|delete|run)\b/i.test(n))).toEqual([]);
  });
});
