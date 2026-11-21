// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Job } from '../../services/jobs.service';
import { JobDetail } from './JobDetail';

const auth = vi.hoisted(() => ({ role: 'operator' as string }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));

const failedJob: Job = {
  id: 'job-42',
  name: 'etl-nightly',
  queueName: 'etl-sync',
  progress: 0,
  attempts: 2,
  maxAttempts: 5,
  status: 'failed',
  timestamp: 1_700_000_000_000,
  processedOn: 1_700_000_005_000,
  finishedOn: 1_700_000_065_000,
  failedReason: 'ECONNRESET talking to neo4j',
};

const renderDetail = (job: Job | null, handlers: { onRetry?: () => Promise<void>; onCancel?: () => Promise<void>; onClose?: () => void } = {}) =>
  render(
    <JobDetail
      job={job}
      open
      onClose={handlers.onClose ?? vi.fn()}
      onRetry={handlers.onRetry ?? vi.fn().mockResolvedValue(undefined)}
      onCancel={handlers.onCancel ?? vi.fn().mockResolvedValue(undefined)}
    />,
  );

afterEach(cleanup);

describe('JobDetail', () => {
  it('renders nothing without a job', () => {
    renderDetail(null);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the job, its status as text, its figures and the failure reason', () => {
    auth.role = 'viewer';
    renderDetail(failedJob);

    const dialog = screen.getByRole('dialog', { name: 'Job Details' });
    expect(within(dialog).getByRole('heading', { name: 'etl-nightly' })).toBeInTheDocument();
    expect(within(dialog).getByText('FAILED')).toBeInTheDocument();
    expect(within(dialog).getByText('job-42')).toBeInTheDocument();
    expect(within(dialog).getByText('etl-sync')).toBeInTheDocument();
    expect(within(dialog).getByText('2 / 5')).toBeInTheDocument();
    expect(within(dialog).getByText('1m 0s')).toBeInTheDocument();
    expect(within(dialog).getByText('ECONNRESET talking to neo4j')).toBeInTheDocument();
  });

  it('leaves out the figures a job does not have rather than printing 0', () => {
    auth.role = 'viewer';
    renderDetail({ ...failedJob, status: 'waiting', processedOn: undefined, finishedOn: undefined, failedReason: undefined, delay: 0 });

    expect(screen.queryByText('Started')).not.toBeInTheDocument();
    expect(screen.queryByText('Finished')).not.toBeInTheDocument();
    expect(screen.queryByText('Duration')).not.toBeInTheDocument();
    expect(screen.queryByText('Delay')).not.toBeInTheDocument();
    expect(screen.queryByText('Error Message')).not.toBeInTheDocument();
  });

  it('draws no progress bar and no 0% for a job that reports no progress', () => {
    auth.role = 'viewer';
    renderDetail({ ...failedJob, status: 'active', failedReason: undefined, progress: 0 });
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('draws the reported percent', () => {
    auth.role = 'viewer';
    renderDetail({ ...failedJob, status: 'active', failedReason: undefined, progress: 35 });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35');
    expect(screen.getByText('35%')).toBeInTheDocument();
  });

  it('gives a viewer the details and Close but no Retry', async () => {
    auth.role = 'viewer';
    const onClose = vi.fn();
    renderDetail(failedJob, { onClose });

    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!);
    expect(onClose).toHaveBeenCalled();
  });

  it('lets an operator retry a failed job, with the same id the list row would send', async () => {
    auth.role = 'operator';
    const onRetry = vi.fn().mockResolvedValue(undefined);
    renderDetail(failedJob, { onRetry });

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Retry Job' })).getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledExactlyOnceWith('job-42');
  });

  it('lets an operator cancel an active job, and a viewer not', async () => {
    const active = { ...failedJob, status: 'active' as const, failedReason: undefined };
    auth.role = 'viewer';
    const first = renderDetail(active);
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    first.unmount();

    auth.role = 'operator';
    const onCancel = vi.fn().mockResolvedValue(undefined);
    renderDetail(active, { onCancel });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, Cancel Job' }));
    expect(onCancel).toHaveBeenCalledExactlyOnceWith('job-42');
  });
});
