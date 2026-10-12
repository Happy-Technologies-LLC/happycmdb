// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('axios', () => ({ default: { create: () => ({
  get, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
}) } }));
import { HealthDashboard } from './HealthDashboard';

it('shows global aggregates unavailable while continuing service health, without polling refused metrics', async () => {
  get.mockImplementation(async (path: string) => {
    if (path === '/cmdb-health/services') return { data: [{ service: 'Neo4j', status: 'healthy', last_check: '2026-01-01T00:00:00Z' }] };
    throw { response: { status: 403, data: { error: 'Global health metrics unavailable' } } };
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><HealthDashboard /></QueryClientProvider>);
  expect(screen.getByRole('status')).toHaveTextContent('Global health metrics and time-series are unavailable');
  await waitFor(() => expect(screen.getByText('Neo4j')).toBeInTheDocument());
  expect(get.mock.calls.map(([path]) => path)).toEqual(['/cmdb-health/services']);
  expect(screen.queryByText('Loading chart data...')).not.toBeInTheDocument();
});
