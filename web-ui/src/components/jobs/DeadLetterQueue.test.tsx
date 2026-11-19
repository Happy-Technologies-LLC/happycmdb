// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jobsService, type Job } from '../../services/jobs.service';
import { DeadLetterQueue } from './DeadLetterQueue';

const dead = (over: Partial<Job> = {}): Job => ({
  id: 'job-1',
  name: 'sync-assets',
  queueName: 'etl-sync',
  progress: 0,
  attempts: 3,
  maxAttempts: 3,
  status: 'failed',
  timestamp: 1_700_000_000_000,
  failedReason: 'Job failed',
  ...over,
});

// What axios rejects with: an Error that carries the response.
const refusal = Object.assign(new Error('Request failed with status code 403'), {
  response: { status: 403, data: { success: false, error: 'Forbidden', message: 'Platform administrator required' } },
});

let getDeadLetterJobs: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  getDeadLetterJobs = vi.spyOn(jobsService, 'getDeadLetterJobs');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DeadLetterQueue states', () => {
  it('shows a loading status while the failed jobs are read', () => {
    getDeadLetterJobs.mockReturnValue(new Promise(() => {}));
    render(<DeadLetterQueue queueName="etl-sync" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading dead letter jobs');
  });

  it('says so when no job has exhausted its retries', async () => {
    getDeadLetterJobs.mockResolvedValue([]);
    render(<DeadLetterQueue queueName="etl-sync" />);
    expect(await screen.findByText('No dead letter jobs')).toBeInTheDocument();
  });

  it('shows a retryable error, never a blank or an empty list, when the read fails', async () => {
    getDeadLetterJobs.mockRejectedValueOnce(new Error('queue unreachable')).mockResolvedValueOnce([dead()]);
    render(<DeadLetterQueue queueName="etl-sync" />);

    expect(await screen.findByText('Could not load dead letter jobs')).toBeInTheDocument();
    expect(screen.getByText('queue unreachable')).toBeInTheDocument();
    expect(screen.queryByText('No dead letter jobs')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('sync-assets')).toBeInTheDocument();
    expect(getDeadLetterJobs).toHaveBeenCalledTimes(2);
  });

  it('shows a plain not-permitted state with the server reason on a 403, and no retry', async () => {
    getDeadLetterJobs.mockRejectedValue(refusal);
    render(<DeadLetterQueue queueName="etl-sync" />);

    expect(await screen.findByText('No access to dead letter jobs')).toBeInTheDocument();
    expect(screen.getByText('Platform administrator required')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });
});

describe('DeadLetterQueue list', () => {
  it('reads the failed jobs of the chosen queue and refetches when the queue changes', async () => {
    getDeadLetterJobs.mockResolvedValue([dead()]);
    const { rerender } = render(<DeadLetterQueue queueName="etl-sync" />);
    await screen.findByText('sync-assets');
    expect(getDeadLetterJobs).toHaveBeenLastCalledWith('etl-sync');

    rerender(<DeadLetterQueue queueName="discovery-aws" />);
    await screen.findByText('sync-assets');
    expect(getDeadLetterJobs).toHaveBeenLastCalledWith('discovery-aws');
  });

  it('counts the jobs and reveals a job\'s failure reason on demand', async () => {
    getDeadLetterJobs.mockResolvedValue([dead(), dead({ id: 'job-2', name: 'scan', failedReason: undefined })]);
    render(<DeadLetterQueue queueName="etl-sync" />);

    expect(await screen.findByText(/contains 2 jobs/)).toBeInTheDocument();
    const first = screen.getByRole('button', { name: /sync-assets/ });
    expect(first).toHaveAccessibleName(/3\/3 attempts/);
    expect(first).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(first);
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Job failed')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: /scan/ }));
    expect(screen.getByText('No error message available')).toBeVisible();
  });

  it('refreshes on demand', async () => {
    getDeadLetterJobs.mockResolvedValue([dead()]);
    render(<DeadLetterQueue queueName="etl-sync" />);
    await screen.findByText('sync-assets');

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('sync-assets');
    expect(getDeadLetterJobs).toHaveBeenCalledTimes(2);
  });
});
