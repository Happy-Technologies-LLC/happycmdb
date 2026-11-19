// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen, within } from '@testing-library/react';
import { DiscoveryJobStatus } from './DiscoveryJobStatus';
import type { DiscoveryJob } from '../../services/discovery.service';
import { domLeaks, secretMarker } from '@/tests/utils/secretDom';

const job = (over: Partial<DiscoveryJob> = {}): DiscoveryJob => ({
  id: 'job-1',
  provider: 'ssh',
  status: 'completed',
  progress: 100,
  discoveredCIs: 7,
  createdAt: '2026-03-01T10:00:00Z',
  startedAt: '2026-03-01T10:01:00Z',
  completedAt: '2026-03-01T10:03:30Z',
  config: { targetHosts: ['10.0.0.5'] },
  ...over,
});

describe('DiscoveryJobStatus', () => {
  it('shows the status as a text label and a labelled progress bar only while running', () => {
    const { rerender } = render(<DiscoveryJobStatus job={job({ status: 'running', progress: 40 })} />);
    expect(screen.getByText('Running')).toBeVisible();
    expect(screen.getByRole('progressbar', { name: 'Progress of job job-1' })).toBeVisible();

    rerender(<DiscoveryJobStatus job={job({ status: 'failed' })} />);
    expect(screen.getByText('Failed')).toBeVisible();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('offers Retry only on a failed job and Cancel only on a running one, and calls back with the job', () => {
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(<DiscoveryJobStatus job={job({ status: 'failed' })} onRetry={onRetry} onCancel={onCancel} />);
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledWith('job-1', 'ssh');

    rerender(<DiscoveryJobStatus job={job({ status: 'running', progress: 10 })} onRetry={onRetry} onCancel={onCancel} />);
    expect(screen.getByRole('progressbar', { name: 'Progress of job job-1' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledWith('job-1');
  });

  it('shows a job error as an alert, and a count the server did not send as nothing rather than 0', () => {
    render(<DiscoveryJobStatus job={job({ status: 'failed', error: 'Connection refused', discoveredCIs: undefined as unknown as number })} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Connection refused');
    expect(screen.getByText('Failed')).toBeVisible(); // the failure is also named in text, not by colour alone
    expect(screen.getByRole('heading', { name: /Job ID: job-1/ })).toBeVisible();
    expect(screen.queryByText('Discovered CIs')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Discovered CIs\s*0/);
  });

  it('keeps credential-like config out of the DOM when the logs are opened, and shows the rest', () => {
    const marker = secretMarker('job-config');
    render(
      <DiscoveryJobStatus
        job={job({
          config: { targetHosts: ['10.0.0.5'], password: marker, apiToken: marker, nested: { secretKey: marker }, credentials: { password: marker } },
        })}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show Logs' }));

    const region = screen.getByRole('button', { name: 'Hide Logs' });
    expect(region).toBeVisible();
    expect(screen.getByText('["10.0.0.5"]')).toBeVisible();
    expect(screen.getAllByText('***REDACTED***').length).toBeGreaterThanOrEqual(2);
    expect(domLeaks(marker)).toEqual([]);
    expect(within(document.body).queryByText(/S3CR3T/)).not.toBeInTheDocument();
  });
});
