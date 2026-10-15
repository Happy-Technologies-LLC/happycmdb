// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AxiosResponse } from 'axios';
import { render, screen } from '@testing-library/react';
import { ITSMDashboard } from './ITSMDashboard';
import { apiClient } from '@/services/api';

vi.mock('@/services/api', () => ({ apiClient: { get: vi.fn() } }));

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ITSMDashboard /></QueryClientProvider>);
}

it('shows only totals from scoped record endpoints', async () => {
  vi.mocked(apiClient.get).mockImplementation(async (path) => ({
    data: { success: true, pagination: { total: path === '/itil/incidents' ? 2 : 3 } },
  } as unknown as AxiosResponse));
  renderDashboard();
  expect(await screen.findByText('2')).toBeVisible();
  expect(screen.getByText('3')).toBeVisible();
  expect(apiClient.get).toHaveBeenCalledWith('/itil/incidents', { params: { limit: 1 } });
  expect(apiClient.get).toHaveBeenCalledWith('/itil/changes', { params: { limit: 1 } });
});

it('does not render partial totals when record tables are unavailable', async () => {
  vi.mocked(apiClient.get).mockImplementation(async (path) => {
    if (path === '/itil/changes') throw new Error('503');
    return { data: { success: true, pagination: { total: 42 } } } as unknown as AxiosResponse;
  });
  renderDashboard();
  expect(await screen.findByRole('alert')).toHaveTextContent('ITIL records unavailable');
  expect(screen.queryByText('42')).not.toBeInTheDocument();
});
