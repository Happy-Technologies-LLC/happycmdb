// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// Final cycle-10 live-component retest. F-045: connector definitions and
// runs (ConnectorDefinitionList's runMutation calls connectorsApi.run(name)
// with a success toast, deleteMutation calls connectorsApi.delete(id) wired
// to the delete-confirmation dialog's destructive button;
// ConnectorJobList's handleRowClick toggles expandedJobId for the clicked
// row).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/contexts/ToastContext';

const { apiClient } = vi.hoisted(() => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock('../../lib/api-client', () => ({ apiClient }));

import ConnectorDefinitionList from './ConnectorDefinitionList';
import ConnectorJobList from './ConnectorJobList';

const CONFIGURED_CONNECTOR = {
  id: 'c10fc-cfg-1',
  name: 'C10FC Config Connector',
  type: 'servicenow',
  status: 'active',
  schedule_enabled: false,
  description: 'fixture',
};

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>
  );
}

describe('ConnectorDefinitionList (F-045)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockImplementation((url: string) => {
      if (url === '/connector-configs') return Promise.resolve({ success: true, data: [CONFIGURED_CONNECTOR] });
      if (url === '/connectors/installed') return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
  });

  it('runMutation calls connectorsApi.run(name) (POST /connector-configs/:name/run) when Run Now is clicked', async () => {
    const user = userEvent.setup();
    apiClient.post.mockResolvedValue({ success: true });
    renderWithProviders(<ConnectorDefinitionList />);

    await screen.findByText('C10FC Config Connector');
    await user.click(screen.getByTitle('Run Now'));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(`/connector-configs/${CONFIGURED_CONNECTOR.name}/run`);
    });
  });

  it('deleteMutation is wired to the delete-confirmation dialog\'s destructive action, calling connectorsApi.delete(id)', async () => {
    const user = userEvent.setup();
    apiClient.delete.mockResolvedValue({ success: true });
    renderWithProviders(<ConnectorDefinitionList />);

    await screen.findByText('C10FC Config Connector');
    await user.click(screen.getByTitle('Delete'));

    // A confirmation surface must appear (not an immediate direct delete).
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    const confirmButton = within(dialog as HTMLElement).getByRole('button', { name: /delete/i });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(apiClient.delete).toHaveBeenCalledWith(`/connector-configs/${CONFIGURED_CONNECTOR.id}`);
    });
  });
});

describe('ConnectorJobList (F-045)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockImplementation((url: string) => {
      if (url === '/connector-configs') return Promise.resolve({ success: true, data: [CONFIGURED_CONNECTOR] });
      return Promise.resolve({ data: [] });
    });
  });

  it('handleRowClick toggles expandedJobId, expanding and collapsing one job row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ConnectorJobList />);

    await screen.findAllByText('C10FC Config Connector');

    // The mock job data derives 3 synthetic jobs per configured connector;
    // records_created text is only rendered once a row is expanded.
    expect(screen.queryByText('Records Created')).not.toBeInTheDocument();

    let dataRow!: HTMLElement;
    await waitFor(() => {
      const allRows = screen.getAllByRole('row');
      // Row 0 is the header; 3 synthetic job rows follow once the
      // connector-configs query has resolved (a bare "no jobs" placeholder
      // row would only make allRows.length === 2, so require the full set).
      expect(allRows.length).toBeGreaterThanOrEqual(4);
      dataRow = allRows[1];
    });

    fireEvent.click(dataRow);
    expect(await screen.findByText('Records Created')).toBeInTheDocument();

    // Clicking the same row again collapses it.
    fireEvent.click(dataRow);
    await waitFor(() => {
      expect(screen.queryByText('Records Created')).not.toBeInTheDocument();
    });
  });
});
