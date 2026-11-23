// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const renderDashboard = () =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><HealthDashboard /></QueryClientProvider>);
const respond = (data: unknown) => get.mockReset().mockResolvedValue({ data });

it('labels every service status in words, so it is not carried by colour alone, and never shows a probe time as 0', async () => {
  respond([
    { service: 'Neo4j', status: 'healthy', last_check: '2026-01-01T00:00:00Z', response_time_ms: 3 },
    { service: 'Redis', status: 'degraded', last_check: '2026-01-01T00:00:00Z', response_time_ms: 900 },
    { service: 'ETL', status: 'down', last_check: '2026-01-01T00:00:00Z' },
    { service: 'Agent', status: 'unknown', last_check: '2026-01-01T00:00:00Z' },
  ]);
  renderDashboard();
  const labelOf = async (name: string) => {
    const card = (await screen.findByText(name)).parentElement!.parentElement!.parentElement!;
    return card.textContent ?? '';
  };
  expect(await labelOf('Neo4j')).toContain('Healthy');
  expect(await labelOf('Redis')).toContain('Degraded');
  expect(await labelOf('ETL')).toContain('Down');
  const agent = await labelOf('Agent');
  expect(agent).toContain('Unknown');
  expect(agent).toContain('Not probed');
  expect(agent).not.toMatch(/Healthy|0ms/);
});

it('shows a busy placeholder, not a second status region, while the services load', async () => {
  get.mockReset().mockReturnValue(new Promise(() => undefined));
  const { container } = renderDashboard();
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(screen.getAllByRole('status')).toHaveLength(1);
});

it('says so when no service is reported', async () => {
  respond([]);
  renderDashboard();
  expect(await screen.findByText('No services reported')).toBeInTheDocument();
});

it('shows a failed service read, and a retry brings the services back', async () => {
  get.mockReset()
    .mockRejectedValueOnce(new Error('network down'))
    .mockResolvedValue({ data: [{ service: 'Neo4j', status: 'healthy', last_check: '2026-01-01T00:00:00Z' }] });
  renderDashboard();
  expect(await screen.findByText('Could not load service health')).toBeInTheDocument();
  expect(screen.queryByText('Neo4j')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Neo4j')).toBeInTheDocument();
  expect(get).toHaveBeenCalledTimes(2);
});

it('a refused service read says there is no access, with no retry', async () => {
  get.mockReset().mockRejectedValue({ response: { status: 403, data: { _message: "Permission 'read' required" } } });
  renderDashboard();
  expect(await screen.findByText('No access to service health')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
});
