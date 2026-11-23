// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// Retry is a write (POST /jobs/:queue/:id/retry): a read-only role never gets the control, a writer confirms
// first, and the confirmed click hands the job id to the owner's onRetry unchanged.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Job } from '../../services/jobs.service';
import { JobRetryButton } from './JobRetryButton';
import { winningDeclaration } from '../../tests/utils/tailwindCascade';

const auth = vi.hoisted(() => ({ role: 'operator' as string | undefined }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.role ? { role: auth.role } : null }) }));

const failedJob: Job = {
  id: 'job-7',
  name: 'sync-assets',
  queueName: 'etl-sync',
  progress: 0,
  attempts: 1,
  maxAttempts: 3,
  status: 'failed',
  timestamp: 1_700_000_000_000,
};

afterEach(cleanup);

describe('JobRetryButton', () => {
  it.each(['viewer', undefined])('is not rendered for role %s', (role) => {
    auth.role = role;
    render(<JobRetryButton job={failedJob} onRetry={vi.fn()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each(['operator', 'admin'])('asks for confirmation as %s, then retries the job by id', async (role) => {
    auth.role = role;
    const onRetry = vi.fn().mockResolvedValue(undefined);
    render(<JobRetryButton job={failedJob} onRetry={onRetry} />);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Retry Job' });
    expect(within(dialog).getByText('sync-assets')).toBeInTheDocument();
    expect(within(dialog).getByText('1 / 3')).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledExactlyOnceWith('job-7');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the dialog open and shows the failure when the retry is refused', async () => {
    auth.role = 'operator';
    const onRetry = vi.fn().mockRejectedValue(new Error('Queue mutation unavailable'));
    render(<JobRetryButton job={failedJob} onRetry={onRetry} />);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Error: Queue mutation unavailable')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Retry Job' })).toBeInTheDocument();
  });

  it('closes without retrying when the dialog is cancelled', async () => {
    auth.role = 'operator';
    const onRetry = vi.fn();
    render(<JobRetryButton job={failedJob} onRetry={onRetry} />);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('is disabled once the job has used every attempt', () => {
    auth.role = 'operator';
    render(<JobRetryButton job={{ ...failedJob, attempts: 3 }} onRetry={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled();
  });

  it('closes the heading gap of the confirm dialog title', async () => {
    auth.role = 'operator';
    render(<JobRetryButton job={failedJob} onRetry={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const heading = screen.getByRole('heading', { name: 'Retry Job' });
    expect(await winningDeclaration(heading.parentElement!.className, 'margin-bottom')).toBe('calc(0.25rem * 0)');
  });
});
