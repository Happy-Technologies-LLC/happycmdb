// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// Connector catalog read-only discovery and deployment-only lifecycle presentation.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
