// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DiscoveryJobList } from './DiscoveryJobList';
import { DiscoveryDashboard } from './DiscoveryDashboard';
import { apiClient } from '@/services/api';
import { attachSession } from '@/lib/session';

vi.mock('@/services/api', () => ({ apiClient: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ showToast }) }));

const queued = (id: string, status: string, provider = 'nmap') => ({
  id,
  provider,
  status,
  createdAt: Date.parse('2026-03-01T10:00:00Z'),
  processedOn: Date.parse('2026-03-01T10:01:00Z'),
});

const answer = (jobs: unknown[], totalPages = 1) => ({
  data: { data: jobs, pagination: { total: jobs.length, page: 1, limit: 10, totalPages } },
});

function renderList() {
  return render(
    <MemoryRouter>
      <DiscoveryJobList />
    </MemoryRouter>
  );
}

/** The real session client answering every read with `status`, as the server does for a caller without the role. */
function refuseReads(status: number) {
  const client = axios.create({
    adapter: async (config: InternalAxiosRequestConfig) => {
      const response = { data: { _error: 'Forbidden' }, status, statusText: '', headers: {}, config, request: {} };
      throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, response);
    },
  });
  attachSession(client);
  vi.mocked(apiClient.get).mockImplementation((url, config) => client.get(url, config));
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.post).mockReset().mockResolvedValue({ data: {} });
  vi.mocked(apiClient.delete).mockReset().mockResolvedValue({ data: {} });
  showToast.mockReset();
});

describe('DiscoveryJobList states', () => {
  it('shows a labelled loading state, not an empty table, while the first read is in flight', async () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => undefined));
    renderList();

    expect(await screen.findByRole('status')).toHaveTextContent('Loading discovery jobs…');
    expect(screen.queryByText('No jobs found')).not.toBeInTheDocument();
  });

  it('says so when there are no jobs', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(answer([]));
    renderList();

    expect(await screen.findByText('No jobs found')).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // The filters stay usable, by name, so an empty answer to a filter can be widened again.
    expect(screen.getByRole('combobox', { name: 'Filter by provider' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Filter by status' })).toBeVisible();
  });

  it('shows a visible, retryable error rather than a blank list, and recovers on retry', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('Network Error'));
    renderList();

    expect(await screen.findByText('Could not load discovery jobs')).toBeVisible();
    expect(screen.queryByText('No jobs found')).not.toBeInTheDocument();

    vi.mocked(apiClient.get).mockResolvedValue(answer([queued('job-1', 'completed')]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    const table = await screen.findByRole('table', { name: 'Discovery jobs' });
    expect(within(table).getByText('job-1')).toBeVisible();
  });

  it('a 403 on the platform-admin job read ends in the visible error state, never a spinner, with no write control', async () => {
    refuseReads(403);
    renderList();

    expect(await screen.findByText('Could not load discovery jobs')).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Retry|Cancel)$/ })).not.toBeInTheDocument();
  });
});

describe('DiscoveryJobList rows', () => {
  beforeEach(() => {
    vi.mocked(apiClient.get).mockResolvedValue(
      answer([queued('job-done', 'completed'), queued('job-bad', 'failed', 'ssh'), queued('job-live', 'active')])
    );
  });

  it('shows each status as a text label', async () => {
    renderList();
    const table = await screen.findByRole('table', { name: 'Discovery jobs' });

    expect(within(table).getByText('Completed')).toBeVisible();
    expect(within(table).getByText('Failed')).toBeVisible();
    expect(within(table).getByText('Running')).toBeVisible();
    expect(within(table).getByRole('progressbar', { name: 'Progress of job job-live' })).toBeVisible();
  });

  it('expands a failed job to retry it, and a running job to cancel it, with the same service calls', async () => {
    renderList();
    await screen.findByRole('table', { name: 'Discovery jobs' });

    fireEvent.click(screen.getByText('job-bad'));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/jobs/discovery-ssh/job-bad/retry'));

    fireEvent.click(screen.getByText('job-live'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(apiClient.delete).toHaveBeenCalledWith('/discovery/jobs/job-live'));
  });

  it('filters re-query with the chosen provider and status', async () => {
    renderList();
    await screen.findByRole('table', { name: 'Discovery jobs' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by provider' }), { target: { value: 'ssh' } });
    await waitFor(() => expect(vi.mocked(apiClient.get).mock.calls.at(-1)?.[0]).toContain('provider=ssh'));

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by status' }), { target: { value: 'failed' } });
    await waitFor(() => expect(vi.mocked(apiClient.get).mock.calls.at(-1)?.[0]).toContain('status=failed'));
  });

  it('pages through the result set with labelled controls', async () => {
    vi.mocked(apiClient.get).mockResolvedValue(answer([queued('job-done', 'completed')], 3));
    renderList();
    await screen.findByRole('table', { name: 'Discovery jobs' });

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => expect(vi.mocked(apiClient.get).mock.calls.at(-1)?.[0]).toContain('page=2'));
  });
});

describe('DiscoveryDashboard recent jobs', () => {
  it('shows a visible retryable error on a failed read, never a blank table', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('Network Error'));
    render(
      <MemoryRouter>
        <DiscoveryDashboard />
      </MemoryRouter>
    );

    expect(await screen.findByText('Could not load recent discovery jobs')).toBeVisible();
    expect(screen.queryByText('No recent jobs')).not.toBeInTheDocument();

    vi.mocked(apiClient.get).mockResolvedValue(answer([queued('job-1', 'completed')]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Recent discovery jobs' })).toBeVisible();
  });
});
