// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { apiClient } from '@/services/api';
import { ForbiddenHost } from '@/components/layout/ForbiddenHost';
import { Analytics } from './Analytics';

// The real hooks, service and axios instance run; only the network is replaced, so what is asserted is the
// request each view actually sends and what the page shows for the answer.
type Reply = { status?: number; data?: unknown };
const original = apiClient.defaults.adapter;
const requests: InternalAxiosRequestConfig[] = [];
let routes: Record<string, () => Reply | Promise<Reply>> = {};

const adapter: AxiosAdapter = async (config) => {
  requests.push(config);
  const route = routes[config.url ?? ''];
  const reply = route ? await route() : { data: { success: true, data: [] } };
  const status = reply.status ?? 200;
  const response = { status, statusText: String(status), data: reply.data, headers: {}, config };
  if (status >= 400) {
    throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, response);
  }
  return response;
};

const dashboard = (over: Record<string, unknown> = {}) => ({
  total_cis: 10,
  by_type: {},
  by_status: { active: 9 },
  by_environment: {},
  recent_discoveries: [],
  health_score: 80,
  critical_relationships: 3,
  ...over,
});
const discovery = {
  success: true,
  data: { summary: { total_cis: 4, unique_types: 2, first_discovery: null, last_discovery: null }, by_provider: [] },
};

const callsTo = (url: string) => requests.filter((r) => r.url === url);

beforeEach(() => {
  requests.length = 0;
  routes = {
    '/analytics/dashboard': () => ({ data: dashboard() }),
    '/analytics/discovery-stats': () => ({ data: discovery }),
  };
  apiClient.defaults.adapter = adapter;
});
afterEach(() => {
  apiClient.defaults.adapter = original;
  vi.useRealTimers();
  cleanup();
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <ForbiddenHost />
      <Analytics />
    </MemoryRouter>,
  );

const card = (title: string): HTMLElement => {
  const found = screen.getByText(title).closest('.h-full');
  if (!(found instanceof HTMLElement)) throw new Error(`${title} card not found`);
  return found;
};

describe('Analytics page date range', () => {
  it('sends the chosen range to the changes and discovery views, and mounts a view only when it is selected', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-19T12:00:00.000Z'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Total CIs');
    expect(callsTo('/analytics/change-timeline')).toHaveLength(0);

    await user.click(screen.getByRole('tab', { name: 'Changes' }));
    await waitFor(() => expect(callsTo('/analytics/change-timeline')).toHaveLength(1));
    expect(callsTo('/analytics/change-timeline')[0]?.params).toEqual({});

    // The page-level selector is the first one in the DOM; the panel carries its own below it.
    await user.click(screen.getAllByRole('button', { name: 'Last 30 Days' })[0]!);
    const range = { start_date: '2026-10-20T12:00:00.000Z', end_date: '2026-11-19T12:00:00.000Z' };
    await waitFor(() => expect(callsTo('/analytics/change-timeline')).toHaveLength(2));
    expect(callsTo('/analytics/change-timeline')[1]?.params).toEqual(range);

    await user.click(screen.getByRole('tab', { name: 'Discovery' }));
    await waitFor(() => expect(callsTo('/analytics/discovery-stats').length).toBeGreaterThan(1));
    expect(callsTo('/analytics/discovery-stats').at(-1)?.params).toEqual(range);
  });
});

describe('Analytics inventory stat cards', () => {
  it('shows a real zero as 0 and an unreported figure as unavailable, never as 0', async () => {
    routes['/analytics/dashboard'] = () => ({
      data: dashboard({ total_cis: 0, by_status: {}, critical_relationships: null, health_score: null }),
    });
    renderPage();
    await screen.findByText('Total CIs');
    await waitFor(() => expect(within(card('Total CIs')).getByText('0')).toBeInTheDocument());
    expect(within(card('Critical Relationships')).getByText('Not available yet')).toBeInTheDocument();
    expect(within(card('Critical Relationships')).queryByText('0')).toBeNull();
    expect(within(card('Health Score')).queryByText('0%')).toBeNull();
  });
});

describe('Analytics read states', () => {
  it('a failed statistics read is visible, retryable, and the retry replaces it with the figures', async () => {
    let attempt = 0;
    routes['/analytics/dashboard'] = () =>
      ++attempt === 1 ? { status: 500, data: { error: 'boom' } } : { data: dashboard({ total_cis: 7 }) };
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Failed to load statistics')).toBeInTheDocument();
    expect(screen.queryByText('Total CIs')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Total CIs')).toBeInTheDocument();
    expect(within(card('Total CIs')).getByText('7')).toBeInTheDocument();
    expect(callsTo('/analytics/dashboard')).toHaveLength(2);
  });

  it('a 403 reaches the global banner and the page says it is not permitted, with no spinner left and no retry', async () => {
    routes['/analytics/dashboard'] = () => ({ status: 403, data: { _message: "Permission 'read' required" } });
    renderPage();

    expect(await screen.findByText('Not permitted to view statistics')).toBeInTheDocument();
    expect(screen.getByText('Access denied.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('a chart panel shows loading, then an empty state, and a failed one retries', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let attempt = 0;
    routes['/analytics/top-connected'] = () => {
      attempt += 1;
      if (attempt === 1) return gate.then(() => ({ status: 500, data: { error: 'boom' } }));
      return { data: { success: true, data: [] } };
    };
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Total CIs');
    await user.click(screen.getByRole('tab', { name: 'Connections' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Loading');
    release();
    expect(await screen.findByText('Failed to load data')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No data available')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load data')).toBeNull();
    expect(callsTo('/analytics/top-connected')).toHaveLength(2);
  });
});
