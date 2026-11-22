// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InternalAxiosRequestConfig } from 'axios';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ForbiddenHost } from '@/components/layout/ForbiddenHost';
import type { Anomaly } from '@/types';
import { AnomalyDetectionView } from './AnomalyDetectionView';

const auth = vi.hoisted(() => ({ role: 'viewer' }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));

// The real api client, query hooks and view run; only the network is replaced (axios instances created by the
// app inherit this default adapter), so a request is asserted as the request that would go to the server.
type Reply = { status?: number; data?: unknown };
const net = vi.hoisted(() => ({
  seen: [] as InternalAxiosRequestConfig[],
  routes: {} as Record<string, () => Reply | Promise<Reply>>,
}));
vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  actual.default.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    net.seen.push(config);
    const route = net.routes[`${(config.method ?? 'get').toUpperCase()} ${config.url}`];
    const reply = route ? await route() : { data: { success: true, data: [] } };
    const status = reply.status ?? 200;
    const response = { status, statusText: String(status), data: reply.data, headers: {}, config };
    if (status >= 400) {
      throw new actual.AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, response);
    }
    return response;
  };
  return actual;
});

const anomaly = (id: string, over: Partial<Anomaly> = {}): Anomaly => ({
  id,
  ci_id: `ci-${id}`,
  ci_name: `host-${id}`,
  anomaly_type: 'cpu_spike',
  severity: 'high',
  confidence_score: 91,
  detected_at: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
  description: `description of ${id}`,
  metrics: {},
  context: {},
  status: 'detected',
  ...over,
});
const stats = (over: Record<string, unknown> = {}) => ({
  success: true,
  data: { total: 5, by_severity: { critical: 2, high: 1 }, by_type: {}, by_status: { detected: 3, investigating: 1 }, ...over },
});
const serve = (list: Anomaly[]) => {
  net.routes['GET /anomalies/recent'] = () => ({ data: { success: true, data: list } });
};
const patches = () => net.seen.filter((c) => c.method === 'patch');

beforeEach(() => {
  net.seen.length = 0;
  net.routes = { 'GET /anomalies/stats': () => ({ data: stats() }) };
  auth.role = 'viewer';
  serve([anomaly('a1')]);
});
afterEach(cleanup);

const renderView = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ForbiddenHost />
        <AnomalyDetectionView />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const filter = (group: 'Severity' | 'Status', name: string) =>
  within(screen.getByRole('group', { name: group })).getByRole('button', { name });
const findFilter = async (group: 'Severity' | 'Status', name: string) => {
  await screen.findByRole('group', { name: group });
  return filter(group, name);
};

const WRITE_ACTIONS = ['Investigate', 'Resolve', 'Mark False Positive'];

describe('AnomalyDetectionView actions by role', () => {
  it('a viewer sees the detections and none of the write controls', async () => {
    renderView();
    expect(await screen.findByText('description of a1')).toBeInTheDocument();
    for (const name of WRITE_ACTIONS) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it.each([
    ['Investigate', 'investigating'],
    ['Resolve', 'resolved'],
    ['Mark False Positive', 'false_positive'],
  ])('an operator pressing %s sends status %s for that anomaly', async (name, status) => {
    auth.role = 'operator';
    net.routes['PATCH /anomalies/a1/status'] = () => ({ data: { success: true, data: anomaly('a1') } });
    renderView();
    await userEvent.setup().click(await screen.findByRole('button', { name }));

    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]?.url).toBe('/anomalies/a1/status');
    expect(JSON.parse(String(patches()[0]?.data))).toEqual({ status });
  });

  it('offers Resolve and Mark False Positive, but not Investigate, once investigating', async () => {
    auth.role = 'operator';
    serve([anomaly('a1', { status: 'investigating' })]);
    renderView();
    await userEvent.setup().click(await findFilter('Status', 'Investigating'));
    expect(await screen.findByRole('button', { name: 'Resolve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark False Positive' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Investigate' })).toBeNull();
  });

  it('shows a resolved detection as resolved and offers nothing to do to it', async () => {
    auth.role = 'operator';
    serve([anomaly('a1', { status: 'resolved', resolved_at: new Date().toISOString() })]);
    renderView();
    await userEvent.setup().click(await findFilter('Status', 'Resolved'));
    const article = (await screen.findByText('description of a1')).closest('article') as HTMLElement;
    expect(within(article).getByText(/^Resolved/)).toBeInTheDocument();
    for (const name of WRITE_ACTIONS) expect(within(article).queryByRole('button', { name })).toBeNull();
  });
});

describe('AnomalyDetectionView filters', () => {
  it('lists only detected anomalies at first and narrows by severity and status on request', async () => {
    serve([
      anomaly('a1', { severity: 'critical' }),
      anomaly('a2', { severity: 'low' }),
      anomaly('a3', { status: 'resolved' }),
    ]);
    const user = userEvent.setup();
    renderView();
    await screen.findByText('description of a1');
    expect(screen.getByText('description of a2')).toBeInTheDocument();
    expect(screen.queryByText('description of a3')).toBeNull();

    await user.click(filter('Severity', 'Critical'));
    expect(screen.queryByText('description of a2')).toBeNull();
    expect(filter('Severity', 'Critical')).toHaveAttribute('aria-pressed', 'true');

    await user.click(filter('Severity', 'All'));
    await user.click(filter('Status', 'All'));
    expect(screen.getByText('description of a3')).toBeInTheDocument();
  });
});

describe('AnomalyDetectionView statistics', () => {
  it('shows real counts, a missing severity as 0, and the unresolved sum', async () => {
    net.routes['GET /anomalies/stats'] = () => ({
      data: stats({ total: 0, by_severity: {}, by_status: { detected: 2, investigating: 3 } }),
    });
    renderView();
    const statCard = (label: string) => screen.getByText(label, { selector: 'span' }).parentElement!.parentElement!;
    await screen.findByText('Total Anomalies');
    expect(within(statCard('Total Anomalies')).getByText('0')).toBeInTheDocument();
    expect(within(statCard('Critical')).getByText('0')).toBeInTheDocument();
    expect(within(statCard('High')).getByText('0')).toBeInTheDocument();
    expect(within(statCard('Unresolved')).getByText('5')).toBeInTheDocument();
  });

  it('a failed statistics read shows an error instead of zeros, and the list still loads', async () => {
    net.routes['GET /anomalies/stats'] = () => ({ status: 500, data: {} });
    renderView();
    expect(await screen.findByText('Could not load anomaly statistics')).toBeInTheDocument();
    expect(screen.queryByText('Total Anomalies')).toBeNull();
    expect(await screen.findByText('description of a1')).toBeInTheDocument();
  });
});

describe('AnomalyDetectionView read states', () => {
  it('says it is loading while the list is pending', async () => {
    net.routes['GET /anomalies/recent'] = () => new Promise<Reply>(() => undefined);
    renderView();
    expect(await screen.findByRole('status')).toHaveTextContent('Loading anomalies');
  });

  it('says so when nothing matches', async () => {
    serve([]);
    renderView();
    expect(await screen.findByText('No anomalies found matching the selected filters')).toBeInTheDocument();
  });

  it('shows a failed list read, retries on request, and then shows the list', async () => {
    let attempt = 0;
    net.routes['GET /anomalies/recent'] = () =>
      ++attempt === 1 ? { status: 500, data: {} } : { data: { success: true, data: [anomaly('a1')] } };
    renderView();
    expect(await screen.findByText('Could not load anomalies')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('description of a1')).toBeInTheDocument();
    expect(screen.queryByText('Could not load anomalies')).toBeNull();
  });

  it('a 403 reaches the global banner and the list says there is no access, with no retry and no spinner', async () => {
    net.routes['GET /anomalies/recent'] = () => ({ status: 403, data: { _message: "Permission 'read' required" } });
    renderView();
    expect(await screen.findByText('No access to anomalies')).toBeInTheDocument();
    expect(screen.getByText('Access denied.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
