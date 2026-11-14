// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { jobsServiceMock } = vi.hoisted(() => ({
  jobsServiceMock: {
    getJobs: vi.fn(),
    retryJob: vi.fn(),
    cancelJob: vi.fn(),
  },
}));

vi.mock('../services/jobs.service', () => ({
  jobsService: jobsServiceMock,
}));

import { useJobs } from './useJobs';

describe('useJobs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes hasMore exactly as jobsService.getJobs reports it', async () => {
    jobsServiceMock.getJobs.mockResolvedValue({
      jobs: [{ id: 'job-1' }, { id: 'job-2' }],
      hasMore: true,
      limit: 2,
      offset: 0,
    });

    const { result } = renderHook(() =>
      useJobs({ queueName: 'discovery-nmap', filters: { limit: 2, offset: 0 } })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);
  });

  it('keeps hasMore false for a full last page, however many jobs it holds', async () => {
    jobsServiceMock.getJobs.mockResolvedValue({
      jobs: [{ id: 'job-1' }, { id: 'job-2' }],
      hasMore: false,
      limit: 2,
      offset: 0,
    });

    const { result } = renderHook(() =>
      useJobs({ queueName: 'discovery-nmap', filters: { limit: 2, offset: 0 } })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.jobs).toHaveLength(2);
    expect(result.current.hasMore).toBe(false);
  });

  it('does not refetch when the caller passes a new filters object literal with the same field values on every render', async () => {
    jobsServiceMock.getJobs.mockResolvedValue({
      jobs: [],
      hasMore: false,
      limit: 25,
      offset: 0,
    });

    const { result, rerender } = renderHook(
      ({ status }: { status: 'active' | 'waiting' }) =>
        useJobs({
          queueName: 'discovery-nmap',
          // A fresh object literal every render, exactly like Jobs.tsx/JobMonitor.tsx construct `filters` inline.
          filters: { status, limit: 25, offset: 0 },
        }),
      { initialProps: { status: 'active' } }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(jobsServiceMock.getJobs).toHaveBeenCalledTimes(1);

    // Re-render with an equivalent (but referentially new) filters object - identity-only
    // churn must not trigger another fetch.
    rerender({ status: 'active' });
    rerender({ status: 'active' });

    await waitFor(() => expect(jobsServiceMock.getJobs).toHaveBeenCalledTimes(1));

    // A genuine scalar change (status flips) must still trigger exactly one more fetch.
    rerender({ status: 'waiting' });

    await waitFor(() => expect(jobsServiceMock.getJobs).toHaveBeenCalledTimes(2));
  });
});
