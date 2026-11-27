// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1922 S8h: the Jobs screen on the design system. The real services/api client and its real interceptors talk to
// this adapter, which plays the server (every /jobs route needs a platform administrator, jobs.routes.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const auth = vi.hoisted(() => ({ role: 'operator' }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

type Reply = { status: number; data: unknown } | 'pending';
let requests: string[] = [];
let listReply: (url: string, params: Record<string, string>) => Reply;

const { default: axios } = await import('axios');
axios.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
  const url = String(config.url);
  requests.push(`${config.method} ${url}`);
  const reply: Reply =
    config.method === 'get'
      ? listReply(url, (config.params ?? {}) as Record<string, string>)
      : { status: 200, data: { success: true, data: {} } };
  if (reply === 'pending') return new Promise(() => {});
  const response = { data: reply.data, status: reply.status, statusText: '', headers: {}, config, request: {} };
  if (reply.status < 400) return response;
  throw new AxiosError(`Request failed with status code ${reply.status}`, 'ERR_BAD_REQUEST', config, {}, response);
};
const { Jobs } = await import('./Jobs');
const { ForbiddenHost } = await import('../components/layout/ForbiddenHost');
const { jobsService } = await import('../services/jobs.service');

const raw = (over: Record<string, unknown> = {}) => ({
  id: 'job-9',
  name: 'sync-assets',
  queueName: 'discovery-aws',
  attemptsMade: 1,
  maxAttempts: 3,
  state: 'failed',
  timestamp: 1_700_000_000_000,
  ...over,
});
const listing = (jobs: unknown[]) => ({ status: 200, data: { success: true, data: { jobs }, pagination: { limit: 25, offset: 0, hasMore: false } } });
const refusal: Reply = { status: 403, data: { success: false, error: 'Forbidden', message: 'Platform administrator required' } };

const mount = () =>
  render(
    <MemoryRouter>
      <ForbiddenHost />
      <Jobs />
    </MemoryRouter>,
  );

beforeEach(() => {
  requests = [];
  auth.role = 'operator';
  listReply = () => listing([]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Jobs states', () => {
  it('shows a loading status while the first read is pending', async () => {
    listReply = () => 'pending';
    mount();
    expect(await screen.findByRole('status')).toHaveTextContent('Loading jobs');
  });

  it('says "No jobs found" for an empty queue', async () => {
    mount();
    await userEvent.click(screen.getByRole('tab', { name: 'Completed' }));
    expect(await screen.findByText('No jobs found')).toBeInTheDocument();
  });

  it('shows a retryable error on a failed read and recovers on retry', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    listReply = (_url, params) => {
      if (params.state !== 'completed') return listing([]);
      attempts += 1;
      return attempts === 1 ? { status: 500, data: { success: false } } : listing([raw({ state: 'completed' })]);
    };
    mount();
    await user.click(screen.getByRole('tab', { name: 'Completed' }));

    expect(await screen.findByText('Could not load completed jobs')).toBeInTheDocument();
    expect(screen.queryByText('No jobs found')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('sync-assets')).toBeInTheDocument();
  });

  it('a 403 read reaches the shell banner and the page shows its own not-permitted state, not a spinner', async () => {
    listReply = () => refusal;
    mount();

    expect(await screen.findByText('Access denied.')).toBeInTheDocument();
    expect(await screen.findByText('No access to jobs')).toBeInTheDocument();
    expect(screen.getAllByText('Platform administrator required').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/could not load/i)).not.toBeInTheDocument();
  });

  it('names the queue and the dead-letter tab, and reads the dead-letter queue of the chosen queue', async () => {
    const user = userEvent.setup();
    listReply = (url) =>
      url.endsWith('/failed')
        ? { status: 200, data: { success: true, data: { failedJobs: [raw()] } } }
        : listing([]);
    mount();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Queue' }), 'etl-sync');
    await user.click(screen.getByRole('tab', { name: 'Dead Letter' }));

    expect(await screen.findByText('sync-assets')).toBeInTheDocument();
    expect(requests).toContain('get /jobs/etl-sync/failed');
  });
});

describe('Jobs write controls by role', () => {
  const failedListing = (url: string, params: Record<string, string>): Reply =>
    url === '/jobs/discovery-aws' && params.state === 'failed' ? listing([raw()]) : listing([]);

  it('a viewer sees the failed job and its details, and no Retry', async () => {
    auth.role = 'viewer';
    listReply = failedListing;
    mount();
    await userEvent.click(screen.getByRole('tab', { name: 'Failed' }));

    expect(await screen.findByText('sync-assets')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View Details' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('an operator retries the failed job through the same service call and request as before', async () => {
    const user = userEvent.setup();
    const retryJob = vi.spyOn(jobsService, 'retryJob');
    listReply = failedListing;
    mount();
    await user.click(screen.getByRole('tab', { name: 'Failed' }));
    await screen.findByText('sync-assets');

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retryJob).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog', { name: 'Retry Job' })).getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(retryJob).toHaveBeenCalledExactlyOnceWith('discovery-aws', 'job-9'));
    expect(requests).toContain('post /jobs/discovery-aws/job-9/retry');
  });
});
