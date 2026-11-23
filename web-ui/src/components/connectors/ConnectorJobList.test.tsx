// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// Jobs tab (HAP-1922 S8j): table content, the four read states (loading, empty, failed and retryable,
// refused with 403), tone-plus-text status badges, and unknown figures rendered as the unavailable marker, never as 0.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { ForbiddenHost } from '@/components/layout/ForbiddenHost';
import { attachSession } from '@/lib/session';
import { UNKNOWN_VALUE } from '@/api/connectors';
import { ConnectorJobList } from './ConnectorJobList';

const { apiClient } = vi.hoisted(() => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/lib/api-client', () => ({ apiClient }));
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => false }));

const RUNS_PATH = '/connector-configs/runs/all';

const run = (id: string, overrides: Record<string, unknown> = {}) => ({
  id: `run-id-${id}`, organization_id: 'org-synthetic', config_id: 'cfg-1',
  connector_type: 'servicenow', config_name: 'My ServiceNow', resource_id: null,
  started_at: '2026-10-20T10:00:00Z', completed_at: null, status: 'completed',
  records_extracted: null, records_transformed: null, records_loaded: null,
  records_failed: null, duration_ms: null, triggered_by: null, ...overrides,
});
const RUNS = [
  run('01', { status: 'completed', records_loaded: 41 }),
  run('02', { status: 'failed', connector_type: 'bmc_remedy', config_name: 'My Remedy', records_loaded: null }),
  run('03', { status: 'completed', records_loaded: 0 }),
];
const CONFIG = {
  id: 'cfg-1', name: 'My ServiceNow', connector_type: 'servicenow', enabled: true,
  schedule_enabled: false, created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-10T00:00:00Z',
};

const page = (data: unknown[]) => ({ success: true, data, pagination: { total: data.length, count: data.length, limit: 100, offset: 0 } });

function serve(runs: (params: { status?: string }) => Promise<unknown>) {
  apiClient.get.mockImplementation(async (path: string, config?: { params?: { status?: string } }) => {
    if (path === '/connector-configs') return { data: [CONFIG] };
    if (path === RUNS_PATH) return runs(config?.params ?? {});
    throw new Error('Unexpected test endpoint');
  });
}

/** The real session client (its 403 interceptor reports to ForbiddenHost) answering every read with a refusal. */
function refuseReads() {
  const client = axios.create({
    adapter: async (config: InternalAxiosRequestConfig) => {
      const response = {
        data: { _error: 'Forbidden', _message: "Permission 'read' required" },
        status: 403, statusText: '', headers: {}, config, request: {},
      };
      throw new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', config, {}, response);
    },
  });
  attachSession(client);
  apiClient.get.mockImplementation((url: string, config?: unknown) => client.get(url, config as never));
}

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ForbiddenHost />
        <ConnectorJobList />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const runRows = () => screen.queryAllByRole('button').filter((row) => /run-id-\d+/.test(row.textContent ?? ''));
const row = (n: string) => runRows().find((r) => r.textContent!.includes(`run-id-${n}`))!;

beforeEach(() => {
  apiClient.get.mockReset();
});

describe('job list content', () => {
  it('shows the six columns and each run row with its identifier, connector, type, status, loaded count and start', async () => {
    serve(() => Promise.resolve(page(RUNS)));
    mount();
    await waitFor(() => expect(runRows()).toHaveLength(3));

    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent).filter(Boolean);
    expect(headers).toEqual(['Run ID', 'Connector', 'Type', 'Status', 'Records Loaded', 'Started']);

    const first = within(row('01'));
    expect(first.getByText('run-id-01')).toBeVisible();
    expect(first.getByText('My ServiceNow')).toBeVisible();
    expect(first.getByText('servicenow')).toBeVisible();
    expect(first.getByText('Completed')).toBeVisible();
    expect(first.getByText('41')).toBeVisible();
    expect(first.getByText(new Date('2026-10-20T10:00:00Z').toLocaleString())).toBeVisible();
    expect(within(row('02')).getByText('bmc remedy')).toBeVisible();
  });

  it('renders an unreported loaded count as the unavailable marker and a reported zero as 0', async () => {
    serve(() => Promise.resolve(page(RUNS)));
    mount();
    await waitFor(() => expect(runRows()).toHaveLength(3));

    expect(within(row('02')).getByText(UNKNOWN_VALUE)).toBeVisible();
    expect(within(row('02')).queryByText('0')).not.toBeInTheDocument();
    expect(within(row('03')).getByText('0')).toBeVisible();
  });

  it('gives each status a text label and a distinct tone, so colour is never the only signal', async () => {
    serve(() => Promise.resolve(page(RUNS)));
    mount();
    await waitFor(() => expect(runRows()).toHaveLength(3));

    const failed = within(row('02')).getByText('Failed');
    const completed = within(row('01')).getByText('Completed');
    expect(failed.className).not.toBe(completed.className);
    expect(within(row('03')).getByText('Completed').className).toBe(completed.className);
  });

  it('shows a viewer the runs and no action beyond reading them', async () => {
    serve(() => Promise.resolve(page(RUNS)));
    mount();
    await waitFor(() => expect(runRows()).toHaveLength(3));

    const names = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    expect(names.filter((n) => /\b(run now|retry|cancel|delete|install|deploy|edit)\b/i.test(n))).toEqual([]);
  });

  it('expands a row to its detail and asks the server for the selected status', async () => {
    const user = userEvent.setup();
    serve((params) => Promise.resolve(page(RUNS.filter((r) => !params.status || r.status === params.status))));
    mount();
    await waitFor(() => expect(runRows()).toHaveLength(3));

    await user.click(row('01'));
    expect(within(screen.getByTestId('run-detail')).getByText('Records Extracted')).toBeVisible();

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'failed');
    await waitFor(() => expect(runRows()).toHaveLength(1));
    expect(apiClient.get).toHaveBeenLastCalledWith(RUNS_PATH, {
      params: { sort_by: 'started_at', sort_order: 'desc', status: 'failed' },
    });
  });
});

describe('job list states', () => {
  it('shows a labelled loading state while runs are in flight, with no rows and no count', async () => {
    serve(() => new Promise(() => undefined));
    mount();

    expect(await screen.findByRole('status')).toHaveTextContent('Loading connector runs…');
    expect(runRows()).toHaveLength(0);
    expect(screen.queryByText('No connector runs recorded')).not.toBeInTheDocument();
  });

  it('says so when no run has been recorded', async () => {
    serve(() => Promise.resolve(page([])));
    mount();

    expect(await screen.findByText('No connector runs recorded')).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a visible, retryable error for a failed read, never a blank page', async () => {
    const user = userEvent.setup();
    serve(() => Promise.reject(new Error('upstream exploded')));
    const { container } = mount();

    expect(await screen.findByText('Failed to load connector runs')).toBeVisible();
    expect(container.textContent).not.toContain('upstream exploded');
    expect(runRows()).toHaveLength(0);

    serve(() => Promise.resolve(page(RUNS)));
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(runRows()).toHaveLength(3));
    expect(screen.queryByText('Failed to load connector runs')).not.toBeInTheDocument();
  });

  it('shows its own not-permitted state on a 403 while the shell banner shows the server reason, not a spinner or a retry', async () => {
    refuseReads();
    mount();

    expect(await screen.findByText('No access to connector runs')).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent("Access denied. Permission 'read' required");
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(runRows()).toHaveLength(0);
  });
});
