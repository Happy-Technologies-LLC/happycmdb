// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jobsService, type Job } from '../../services/jobs.service';
import { JobMonitor } from './JobMonitor';

const auth = vi.hoisted(() => ({ role: 'operator' }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));

const job = (over: Partial<Job> = {}): Job => ({
  id: 'job-1',
  name: 'scan-prod',
  queueName: 'discovery-aws',
  progress: 0,
  attempts: 1,
  maxAttempts: 3,
  status: 'active',
  timestamp: 1_700_000_000_000,
  ...over,
});
const page = (jobs: Job[]) => ({ jobs, hasMore: false, limit: 25, offset: 0 });
// What axios rejects with: an Error that carries the response.
const refusal = Object.assign(new Error('Request failed with status code 403'), {
  response: { status: 403, data: { success: false, error: 'Forbidden', message: 'Platform administrator required' } },
});

let getJobs: ReturnType<typeof vi.spyOn>;
let cancelJob: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  auth.role = 'operator';
  getJobs = vi.spyOn(jobsService, 'getJobs');
  cancelJob = vi.spyOn(jobsService, 'cancelJob').mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mount = () => render(<JobMonitor autoRefresh={false} />);

describe('JobMonitor states', () => {
  it('shows a loading status before the first answer', () => {
    getJobs.mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.getByRole('status')).toHaveTextContent('Loading jobs');
    expect(screen.queryByText('No jobs found')).not.toBeInTheDocument();
  });

  it('says so when the queue has no jobs in the chosen state', async () => {
    getJobs.mockResolvedValue(page([]));
    mount();
    expect(await screen.findByText('No jobs found')).toBeInTheDocument();
  });

  it('shows a retryable error when the read fails, then the jobs after a retry', async () => {
    getJobs.mockRejectedValueOnce(new Error('redis down')).mockResolvedValueOnce(page([job()]));
    mount();

    expect(await screen.findByText('Could not load jobs')).toBeInTheDocument();
    expect(screen.getByText('redis down')).toBeInTheDocument();
    expect(screen.queryByText('No jobs found')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('scan-prod')).toBeInTheDocument();
  });

  it('shows the server reason as a not-permitted state on a 403, not a spinner or an error to retry', async () => {
    getJobs.mockRejectedValue(refusal);
    mount();

    expect(await screen.findByText('No access to jobs')).toBeInTheDocument();
    expect(screen.getByText('Platform administrator required')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('JobMonitor queries', () => {
  it('asks for the selected status and queue, from the first page', async () => {
    getJobs.mockResolvedValue(page([]));
    mount();
    await screen.findByText('No jobs found');
    expect(getJobs).toHaveBeenLastCalledWith('discovery-aws', { status: 'active', limit: 25, offset: 0 });

    await userEvent.click(screen.getByRole('tab', { name: 'Waiting Jobs' }));
    expect(getJobs).toHaveBeenLastCalledWith('discovery-aws', { status: 'waiting', limit: 25, offset: 0 });

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Queue Filter' }), 'etl-sync');
    expect(getJobs).toHaveBeenLastCalledWith('etl-sync', { status: 'waiting', limit: 25, offset: 0 });
  });

  it('groups the queues and labels each job status in words', async () => {
    getJobs.mockResolvedValue(page([job()]));
    mount();
    await screen.findByText('scan-prod');

    const select = screen.getByRole('combobox', { name: 'Queue Filter' });
    expect(within(select).getByRole('group', { name: 'Discovery Queues' })).toBeInTheDocument();
    expect(within(select).getByRole('group', { name: 'ETL Queues' })).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });
});

describe('JobMonitor write controls by role', () => {
  it('lets a viewer read the jobs and open details, with no Cancel', async () => {
    auth.role = 'viewer';
    getJobs.mockResolvedValue(page([job()]));
    mount();

    expect(await screen.findByText('scan-prod')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View Details' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('lets an operator cancel an active job: the service gets the queue and job id', async () => {
    getJobs.mockResolvedValue(page([job()]));
    mount();
    await screen.findByText('scan-prod');

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancelJob).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Cancel Job' })).getByRole('button', { name: 'Yes, Cancel Job' }));

    expect(cancelJob).toHaveBeenCalledExactlyOnceWith('discovery-aws', 'job-1');
    expect(getJobs).toHaveBeenCalledTimes(2);
  });

  it('opens the details of a job from its row', async () => {
    getJobs.mockResolvedValue(page([job({ failedReason: undefined })]));
    mount();
    await screen.findByText('scan-prod');

    await userEvent.click(screen.getByRole('button', { name: 'View Details' }));
    const dialog = screen.getByRole('dialog', { name: 'Job Details' });
    expect(within(dialog).getByRole('heading', { name: 'scan-prod' })).toBeInTheDocument();
  });
});
