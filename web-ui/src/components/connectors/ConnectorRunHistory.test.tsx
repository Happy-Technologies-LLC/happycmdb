// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const { apiClient } = vi.hoisted(() => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/lib/api-client', () => ({ apiClient }));
vi.mock('@happy-technologies/design-system', () => ({ Icon: () => null }));

import { ConnectorDashboard } from './ConnectorDashboard';
import { ConnectorJobList } from './ConnectorJobList';

const RUNS_PATH = '/connector-configs/runs/all';

// Synthetic, deliberately unsorted. Newest-first order is 08, 04, 02, 07, 05, 01,
// then the two runs without a usable started_at in their input order (03, 06).
const run = (id: string, overrides: Record<string, unknown>) => ({
  id: `run-id-${id}`, organization_id: 'org-synthetic', config_id: 'cfg-1',
  connector_type: 'servicenow', config_name: 'My ServiceNow', resource_id: null,
  started_at: '2026-10-20T10:00:00Z', completed_at: null, status: 'completed',
  records_extracted: null, records_transformed: null, records_loaded: null,
  records_failed: null, duration_ms: null, triggered_by: null, ...overrides,
});
const RUNS = [
  run('01', { started_at: '2026-10-20T10:00:00Z', status: 'completed', records_loaded: 0, records_failed: 0, duration_ms: 125000, completed_at: '2026-10-20T10:02:05Z', triggered_by: 'schedule' }),
  run('02', { started_at: '2026-10-25T09:00:00Z', status: 'failed', records_extracted: 20, records_loaded: 12, records_failed: 3, duration_ms: 4000 }),
  run('03', { started_at: null, status: 'queued' }),
  run('04', { started_at: '2026-10-26T08:00:00Z', status: 'running', records_loaded: 7 }),
  run('05', { started_at: '2026-10-22T08:00:00Z', status: 'cancelled' }),
  run('06', { started_at: 'not-a-date', status: 'completed', records_loaded: 5 }),
  run('07', { started_at: '2026-10-24T08:00:00Z', status: 'completed', records_loaded: 9 }),
  run('08', { started_at: '2026-10-27T01:00:00Z', status: 'completed', connector_type: 'jira', config_name: 'My Jira', records_loaded: 41 }),
];
const NEWEST_FIRST = ['08', '04', '02', '07', '05', '01', '03', '06'].map((n) => `run-id-${n}`);
const STATUS_LABEL: Record<string, string> = {
  '01': 'Completed', '02': 'Failed', '03': 'Queued', '04': 'Running',
  '05': 'Cancelled', '06': 'Completed', '07': 'Completed', '08': 'Completed',
};

const activeConfig = {
  id: 'cfg-1', name: 'My ServiceNow', connector_type: 'servicenow', enabled: true,
  schedule_enabled: false, created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-10T00:00:00Z',
};
// The workday configuration has no runs at all, so only the configuration list can offer it.
const CONFIGS = [activeConfig, { ...activeConfig, id: 'cfg-2', name: 'My Jira', connector_type: 'jira' },
  { ...activeConfig, id: 'cfg-3', name: 'My Workday', connector_type: 'workday' }];

type RunParams = { status?: string; connector_type?: string };
function mockEndpoints(runs: (params: RunParams) => Promise<unknown>) {
  apiClient.get.mockImplementation(async (path: string, config?: { params?: RunParams }) => {
    if (path === '/connector-configs') return { data: CONFIGS };
    if (path === RUNS_PATH) return runs(config?.params ?? {});
    throw new Error('Unexpected test endpoint');
  });
}
/** Emulates the server: filters by the sent params and reports the matching total. */
const ok = (all: unknown[], total?: number) => (params: RunParams) => {
  const data = (all as Array<{ status: string; connector_type: string }>).filter((r) =>
    (!params.status || r.status === params.status) && (!params.connector_type || r.connector_type === params.connector_type));
  return Promise.resolve({ success: true, data, pagination: { total: total ?? data.length, count: data.length, limit: 100, offset: 0 } });
};

function mount(Component: React.ComponentType) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><MemoryRouter><Component /></MemoryRouter></QueryClientProvider>);
}

/** Run rows are the table rows that carry a run identifier; header, empty and detail rows do not. */
const runRows = () => screen.queryAllByRole('row').filter((row) => /run-id-\d+/.test(row.textContent ?? ''));
const rowIds = () => runRows().map((row) => /run-id-\d+/.exec(row.textContent ?? '')![0]);

beforeEach(() => {
  vi.clearAllMocks();
});

// The dashboard shows only the newest five runs; the job list shows the whole returned page.
describe.each([
  ['dashboard', ConnectorDashboard, 5],
  ['job list', ConnectorJobList, RUNS.length],
] as const)('%s run history', (_name, Component, shown) => {
  it('requests the sorted global runs endpoint and shows the returned runs newest-first', async () => {
    mockEndpoints(ok(RUNS));
    mount(Component);
    await waitFor(() => expect(runRows()).toHaveLength(shown));

    expect(apiClient.get).toHaveBeenCalledWith(RUNS_PATH, { params: { sort_by: 'started_at', sort_order: 'desc' } });
    expect(rowIds()).toEqual(NEWEST_FIRST.slice(0, shown));
    for (const row of runRows()) {
      const id = /run-id-(\d+)/.exec(row.textContent ?? '')![1];
      expect(within(row).getByText(`run-id-${id}`)).toBeTruthy(); // full ID, not truncated
      expect(within(row).getByText(STATUS_LABEL[id])).toBeTruthy();
      expect(row.textContent).not.toMatch(/pending|inactive/i);
    }
  });

  it('renders valid timestamps, "—" for missing or invalid ones, and keeps real zero counts', async () => {
    const subset = RUNS.filter((r) => /-0[1368]$/.test(r.id)); // four rows: fits the dashboard cap
    mockEndpoints(ok(subset));
    mount(Component);
    await waitFor(() => expect(runRows()).toHaveLength(subset.length));
    const row = (n: string) => runRows().find((r) => r.textContent!.includes(`run-id-${n}`))!;

    expect(within(row('08')).getByText(new Date('2026-10-27T01:00:00Z').toLocaleString())).toBeTruthy();
    expect(within(row('01')).getByText('0')).toBeTruthy(); // explicit 0 retained
    for (const n of ['03', '06']) {
      expect(within(row(n)).getAllByText('—').length).toBeGreaterThanOrEqual(1);
      expect(row(n).textContent).not.toMatch(/Invalid Date|NaN/);
    }
    // No count is invented for a run that reported none, and there is no progress at all.
    expect(within(row('03')).queryByText('0')).toBeNull();
    expect(within(row('03')).getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryAllByRole('cell').filter((cell) => /%/.test(cell.textContent ?? ''))).toHaveLength(0);
  });

  it('says how many of the matching runs are shown when the server reports more', async () => {
    mockEndpoints(ok(RUNS, 250));
    mount(Component);
    await waitFor(() => expect(runRows()).toHaveLength(shown));

    expect(screen.getByRole('status').textContent).toBe(`Showing newest ${shown} of 250 runs`);
  });

  it('shows no jobs, and no configuration-derived status, when the runs response is empty', async () => {
    mockEndpoints(ok([]));
    mount(Component);

    expect(await screen.findByText('No connector runs recorded')).toBeTruthy();
    expect(runRows()).toHaveLength(0);
    expect(screen.queryByText(/job-cfg-1|Failed to load connector runs/)).toBeNull();
  });

  it('shows a fixed error and no rows when the runs read fails, never leaking the server message', async () => {
    mockEndpoints(() => Promise.reject(new Error('db host 10.0.0.9 refused')));
    mount(Component);

    expect(await screen.findByText('Failed to load connector runs')).toBeTruthy();
    expect(runRows()).toHaveLength(0);
    expect(screen.queryByText(/10\.0\.0\.9|refused/)).toBeNull();
    expect(screen.queryByText('No connector runs recorded')).toBeNull();
  });

  it('shows a loading state, distinct from empty and error, while the runs request is pending', async () => {
    mockEndpoints(() => new Promise(() => {}));
    mount(Component);

    expect(await screen.findByText('Loading connector runs…')).toBeTruthy();
    expect(screen.queryByText('No connector runs recorded')).toBeNull();
    expect(screen.queryByText('Failed to load connector runs')).toBeNull();
    expect(runRows()).toHaveLength(0);
  });

  it('renders an unrecognized actual status verbatim instead of crashing or relabelling it', async () => {
    mockEndpoints(ok([run('09', { status: 'weird_state' })]));
    mount(Component);

    await waitFor(() => expect(runRows()).toHaveLength(1));
    expect(within(runRows()[0]).getByText('weird_state')).toBeTruthy();
  });
});

describe('dashboard configuration summary', () => {
  it('does not present the configuration ratio as a run success rate', async () => {
    mockEndpoints(ok([]));
    mount(ConnectorDashboard);

    await screen.findAllByText('My ServiceNow');
    expect(screen.queryByText('Success Rate')).toBeNull();
  });
});

describe('job list filters and details', () => {
  it('narrows rows by real status and connector type, with an explicit filtered-empty state', async () => {
    mockEndpoints(ok(RUNS));
    const user = userEvent.setup();
    mount(ConnectorJobList);
    await waitFor(() => expect(runRows()).toHaveLength(RUNS.length));
    const sort = { sort_by: 'started_at', sort_order: 'desc' };

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'failed');
    await waitFor(() => expect(rowIds()).toEqual(['run-id-02']));
    expect(apiClient.get).toHaveBeenCalledWith(RUNS_PATH, { params: { ...sort, status: 'failed' } });

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'all');
    await user.selectOptions(screen.getByLabelText('Filter by connector type'), 'jira');
    await waitFor(() => expect(rowIds()).toEqual(['run-id-08']));
    expect(apiClient.get).toHaveBeenCalledWith(RUNS_PATH, { params: { ...sort, connector_type: 'jira' } });

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'failed');
    expect(await screen.findByText('No runs match the selected filters')).toBeTruthy();
    expect(apiClient.get).toHaveBeenCalledWith(RUNS_PATH, { params: { ...sort, status: 'failed', connector_type: 'jira' } });
    expect(runRows()).toHaveLength(0);
    expect(screen.queryByText('No connector runs recorded')).toBeNull();
  });

  it('derives connector-type choices from the configurations, not from the fetched runs', async () => {
    mockEndpoints(ok(RUNS));
    mount(ConnectorJobList);
    await screen.findByRole('option', { name: 'WORKDAY' }); // a configured type with no runs

    const options = within(screen.getByLabelText('Filter by connector type')).getAllByRole('option').map((o) => o.getAttribute('value'));
    expect(options).toEqual(['all', 'jira', 'servicenow', 'workday']);
  });

  it('refetches runs on remount despite the app-wide 5-minute staleTime (Run actions do not invalidate them)', async () => {
    mockEndpoints(ok(RUNS.slice(0, 1)));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5 * 60 * 1000 } } });
    const tree = (key: string) => <QueryClientProvider client={queryClient}><MemoryRouter><ConnectorJobList key={key} /></MemoryRouter></QueryClientProvider>;
    const { rerender } = render(tree('first'));
    await waitFor(() => expect(runRows()).toHaveLength(1));

    mockEndpoints(ok(RUNS.slice(0, 2))); // a run started elsewhere since the first read
    rerender(tree('second'));
    await waitFor(() => expect(runRows()).toHaveLength(2));
  });

  it('expands only real projected fields, keeping unreported ones unknown', async () => {
    mockEndpoints(ok(RUNS));
    const user = userEvent.setup();
    mount(ConnectorJobList);
    await waitFor(() => expect(runRows()).toHaveLength(RUNS.length));

    await user.click(runRows().find((r) => r.textContent!.includes('run-id-02'))!);
    const detail = screen.getByTestId('run-detail');
    expect(within(detail).getByText('Records Extracted').nextElementSibling!.textContent).toBe('20');
    expect(within(detail).getByText('Records Loaded').nextElementSibling!.textContent).toBe('12');
    expect(within(detail).getByText('Records Failed').nextElementSibling!.textContent).toBe('3');
    expect(within(detail).getByText('Records Transformed').nextElementSibling!.textContent).toBe('—');
    expect(within(detail).getByText('Duration').nextElementSibling!.textContent).toBe('4s');
    expect(within(detail).getByText('Triggered By').nextElementSibling!.textContent).toBe('—');
    expect(screen.queryByText(/Records Created|Records Updated/)).toBeNull();
  });
});
