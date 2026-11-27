// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// Connector dashboard (HAP-1922 S8j): configuration figures, the four read states, tone-plus-text status
// badges, navigation, and unknown figures rendered as the unavailable marker, never as 0.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { ForbiddenHost } from '@/components/layout/ForbiddenHost';
import { attachSession } from '@/lib/session';
import { UNKNOWN_VALUE } from '@/api/connectors';
import { ConnectorDashboard } from './ConnectorDashboard';

const { apiClient } = vi.hoisted(() => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/lib/api-client', () => ({ apiClient }));
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => false }));

const RUNS_PATH = '/connector-configs/runs/all';

const config = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, name: `Deployed ${id}`, connector_type: 'servicenow', enabled: true,
  schedule_enabled: false, created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-10T12:00:00Z', ...overrides,
});
const CONFIGS = [config('a'), config('b'), config('c', { enabled: false, connector_type: 'jira' })];

const run = (id: string, overrides: Record<string, unknown> = {}) => ({
  id: `run-id-${id}`, organization_id: 'org-synthetic', config_id: 'a',
  connector_type: 'servicenow', config_name: 'Config a', resource_id: null,
  started_at: '2026-10-20T10:00:00Z', completed_at: null, status: 'completed',
  records_extracted: null, records_transformed: null, records_loaded: 7,
  records_failed: null, duration_ms: null, triggered_by: null, ...overrides,
});
const page = (data: unknown[], total = data.length) => ({
  success: true, data, pagination: { total, count: data.length, limit: 100, offset: 0 },
});

function serve(configs: () => unknown, runs: () => unknown = () => page([run('01'), run('02', { status: 'failed' })])) {
  apiClient.get.mockImplementation(async (path: string) => {
    if (path === '/connector-configs') return configs();
    if (path === RUNS_PATH) return runs();
    throw new Error('Unexpected test endpoint');
  });
}
const configsOk = (rows: unknown[]) => () => Promise.resolve({ success: true, data: rows });

/** The real session client (its 403 interceptor reports to ForbiddenHost) answering every read with a refusal. */
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
  apiClient.get.mockImplementation((url: string, cfg?: unknown) => client.get(url, cfg as never));
}

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
}

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/connectors']}>
        <ForbiddenHost />
        <ConnectorDashboard />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The figure beside a stat label: the label's tile holds both. */
const tile = (label: string) => within(screen.getByText(label).parentElement as HTMLElement);

beforeEach(() => {
  apiClient.get.mockReset();
});

describe('dashboard figures', () => {
  it('counts configurations, not runs, and shows the enabled share with its caption', async () => {
    serve(configsOk(CONFIGS));
    mount();

    await screen.findByText('Deployed a');
    expect(tile('Total Connectors').getByText('3')).toBeVisible();
    expect(tile('Active').getByText('2')).toBeVisible();
    expect(tile('Errors').getByText('0')).toBeVisible();
    expect(tile('Enabled Configurations').getByText('66.7')).toBeVisible();
    expect(screen.getByText('Share of configurations enabled; not a run success rate')).toBeVisible();
  });

  it('shows each deployed connector with its updated date and a status badge that has a text label and its own tone', async () => {
    serve(configsOk(CONFIGS));
    mount();

    await screen.findByText('Deployed a');
    expect(screen.getAllByText(/^Updated:/)).toHaveLength(3);
    expect(screen.getAllByText(new RegExp(new Date('2026-10-10T12:00:00Z').toLocaleDateString()))).toHaveLength(3);
    const active = screen.getAllByText('active')[0];
    const inactive = screen.getByText('inactive');
    expect(active.className).not.toBe(inactive.className);
  });

  it('shows the newest runs with their statuses as tone-plus-text badges', async () => {
    serve(configsOk(CONFIGS));
    mount();

    const failedRow = (await screen.findByText('run-id-02')).closest('tr') as HTMLElement;
    const okRow = screen.getByText('run-id-01').closest('tr') as HTMLElement;
    const failed = within(failedRow).getByText('Failed');
    const completed = within(okRow).getByText('Completed');
    expect(failed.className).not.toBe(completed.className);
    expect(within(okRow).getByText('7')).toBeVisible();
  });

  it('renders an unreported loaded count as the unavailable marker, not 0', async () => {
    serve(configsOk(CONFIGS), () => Promise.resolve(page([run('01', { records_loaded: null })])));
    mount();

    const row = (await screen.findByText('run-id-01')).closest('tr') as HTMLElement;
    expect(within(row).getByText(UNKNOWN_VALUE)).toBeVisible();
    expect(within(row).queryByText('0')).not.toBeInTheDocument();
  });
});

describe('dashboard navigation', () => {
  it('opens the jobs tab on the clicked run, and the whole history from "View all runs"', async () => {
    const user = userEvent.setup();
    serve(configsOk(CONFIGS), () => Promise.resolve(page([run('01')], 9)));
    mount();

    await user.click(await screen.findByText('run-id-01'));
    expect(screen.getByTestId('where')).toHaveTextContent('/connectors?tab=jobs&jobId=run-id-01');

    await user.click(screen.getByRole('button', { name: 'View all runs' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/connectors?tab=jobs');
    expect(screen.getByRole('status')).toHaveTextContent('Showing newest 1 of 9 runs');
  });

  it('opens a deployed connector from the keyboard', async () => {
    const user = userEvent.setup();
    serve(configsOk(CONFIGS));
    mount();

    await screen.findByText('Deployed a');
    const card = screen.getAllByRole('link')[0];
    card.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent('/connectors?tab=definitions');
  });

  it('offers a viewer no write control', async () => {
    serve(configsOk(CONFIGS), () => Promise.resolve(page([run('01')], 9)));
    mount();

    await screen.findByText('Deployed a');
    const names = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(names).toEqual(['View all runs']);
  });
});

describe('dashboard states', () => {
  it('shows no figure and no zero while configurations are loading', async () => {
    serve(() => new Promise(() => undefined), () => new Promise(() => undefined));
    const { container } = mount();

    expect(await screen.findByRole('status')).toHaveTextContent('Loading connector runs…');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText('No connectors deployed yet')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\b0(\.0)?\b/);
    expect(container.textContent).not.toContain('NaN');
  });

  it('says so, with a deploy action, when nothing is deployed; the share is unavailable, the counts are real zeros', async () => {
    const user = userEvent.setup();
    serve(configsOk([]));
    mount();

    expect(await screen.findByText('No connectors deployed yet')).toBeVisible();
    expect(tile('Total Connectors').getByText('0')).toBeVisible();
    expect(tile('Enabled Configurations').getByText(UNKNOWN_VALUE)).toBeVisible();
    expect(tile('Enabled Configurations').queryByText('0.0')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Deploy Connector' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/connectors?tab=definitions');
  });

  it('shows a visible, retryable error and unavailable figures when configurations fail to load, never zeros', async () => {
    serve(() => Promise.reject(new Error('upstream exploded')));
    mount();

    expect(await screen.findByText('Could not load connectors')).toBeVisible();
    expect(screen.getByText('upstream exploded')).toBeVisible();
    for (const label of ['Total Connectors', 'Active', 'Errors', 'Enabled Configurations']) {
      expect(tile(label).getByText(UNKNOWN_VALUE)).toBeVisible();
      expect(tile(label).getByText('Unavailable')).toBeVisible();
    }
    expect(tile('Total Connectors').queryByText('0')).not.toBeInTheDocument();

    serve(configsOk(CONFIGS));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await screen.findByText('Deployed a');
    expect(screen.queryByText('Could not load connectors')).not.toBeInTheDocument();
    expect(tile('Total Connectors').getByText('3')).toBeVisible();
  });

  it('shows its own not-permitted state on a 403 while the shell banner shows the server reason, not a spinner', async () => {
    refuseReads();
    mount();

    expect(await screen.findByText('No access to connectors')).toBeVisible();
    expect(await screen.findByText('No access to connector runs')).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent("Access denied. Permission 'read' required");
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    await waitFor(() => expect(tile('Total Connectors').getByText(UNKNOWN_VALUE)).toBeVisible());
  });
});
