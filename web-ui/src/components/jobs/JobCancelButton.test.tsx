// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// Cancel is a write (DELETE /jobs/:queue/:id): a read-only role never gets the control, a writer confirms first,
// and the confirmed click hands the job id to the owner's onCancel unchanged.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Job } from '../../services/jobs.service';
import { JobCancelButton } from './JobCancelButton';
import { winningDeclaration } from '../../tests/utils/tailwindCascade';

const auth = vi.hoisted(() => ({ role: 'operator' as string | undefined }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: auth.role ? { role: auth.role } : null }) }));

const activeJob: Job = {
  id: 'job-3',
  name: 'scan-prod',
  queueName: 'discovery-ssh',
  progress: 0,
  attempts: 1,
  maxAttempts: 3,
  status: 'active',
  timestamp: 1_700_000_000_000,
};

afterEach(cleanup);

describe('JobCancelButton', () => {
  it.each(['viewer', undefined])('is not rendered for role %s', (role) => {
    auth.role = role;
    render(<JobCancelButton job={activeJob} onCancel={vi.fn()} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it.each(['operator', 'admin'])('asks for confirmation as %s, then cancels the job by id', async (role) => {
    auth.role = role;
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(<JobCancelButton job={activeJob} onCancel={onCancel} />);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Cancel Job' });
    expect(within(dialog).getByText('scan-prod')).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, Cancel Job' }));
    expect(onCancel).toHaveBeenCalledExactlyOnceWith('job-3');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the dialog open and shows the failure when the cancel is refused', async () => {
    auth.role = 'operator';
    const onCancel = vi.fn().mockRejectedValue(new Error('Queue mutation unavailable'));
    render(<JobCancelButton job={activeJob} onCancel={onCancel} />);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Yes, Cancel Job' }));

    expect(await screen.findByText('Error: Queue mutation unavailable')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Cancel Job' })).toBeInTheDocument();
  });

  it('keeps the job when the dialog is dismissed', async () => {
    auth.role = 'operator';
    const onCancel = vi.fn();
    render(<JobCancelButton job={activeJob} onCancel={onCancel} />);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'No, Keep Job' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('is disabled for a job that has already finished', () => {
    auth.role = 'operator';
    render(<JobCancelButton job={{ ...activeJob, status: 'completed' }} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('closes the heading gap of the confirm dialog title', async () => {
    auth.role = 'operator';
    render(<JobCancelButton job={activeJob} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const heading = screen.getByRole('heading', { name: 'Cancel Job' });
    expect(await winningDeclaration(heading.parentElement!.className, 'margin-bottom')).toBe('calc(0.25rem * 0)');
  });
});
