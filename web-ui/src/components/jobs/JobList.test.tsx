// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-2017: the pager is driven by the backend's explicit `hasMore`, never by a
// total the API does not return. A full last page must disable Next; a full page
// with more after it must enable it.

import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@/tests/utils/test-utils';
import { JobList } from './JobList';
import type { Job } from '../../services/jobs.service';

const ROWS_PER_PAGE = 10;

function jobs(count: number): Job[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `job-${i}`,
    name: `job-${i}`,
    queueName: 'etl-sync',
    progress: 100,
    attempts: 1,
    maxAttempts: 3,
    status: 'completed' as const,
    timestamp: 1_700_000_000_000 + i,
  }));
}

function renderList(overrides: { hasMore: boolean; page: number; count?: number; onPageChange?: (p: number) => void }) {
  const onPageChange = overrides.onPageChange ?? vi.fn();
  render(
    <JobList
      jobs={jobs(overrides.count ?? ROWS_PER_PAGE)}
      hasMore={overrides.hasMore}
      page={overrides.page}
      rowsPerPage={ROWS_PER_PAGE}
      onPageChange={onPageChange}
      onRowsPerPageChange={vi.fn()}
      onViewDetails={vi.fn()}
      onRetry={vi.fn()}
      onCancel={vi.fn()}
    />
  );
  return onPageChange;
}

describe('JobList pager (HAP-2017)', () => {
  it('enables Next on a full page that has more jobs after it', async () => {
    const onPageChange = renderList({ hasMore: true, page: 0 });

    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeEnabled();
    await userEvent.click(next);
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('disables Next on a full last page with nothing after it', async () => {
    const onPageChange = renderList({ hasMore: false, page: 2 });

    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();
    await userEvent.click(next);
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it('disables Previous only on the first page', async () => {
    const onPageChange = renderList({ hasMore: true, page: 1 });

    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onPageChange).toHaveBeenCalledWith(0);
  });

  it('disables Previous on page 0 even when more pages follow', () => {
    renderList({ hasMore: true, page: 0 });
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  it('shows the page number without any total', () => {
    renderList({ hasMore: true, page: 2 });
    expect(screen.getByText('Page 3')).toBeInTheDocument();
    expect(screen.queryByText(/total/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ of /)).not.toBeInTheDocument();
  });
});

// HAP-1922 S8h: rows on the design system. Status is words (never colour alone) and progress is drawn only when the
// job reports it.
describe('JobList rows', () => {
  const row = (over: Partial<Job>): Job => ({ ...jobs(1)[0], ...over });
  const renderRows = (list: Job[], loading = false) =>
    render(
      <JobList
        jobs={list}
        hasMore={false}
        page={0}
        rowsPerPage={ROWS_PER_PAGE}
        onPageChange={vi.fn()}
        onRowsPerPageChange={vi.fn()}
        onViewDetails={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        loading={loading}
      />,
    );

  it('labels every status in words', () => {
    const statuses: Job['status'][] = ['active', 'completed', 'failed', 'waiting', 'delayed', 'paused'];
    renderRows(statuses.map((status) => row({ id: status, name: `job-${status}`, status })));
    for (const status of statuses) {
      const line = screen.getByRole('row', { name: new RegExp(`job-${status}`) });
      expect(within(line).getByText(status)).toBeInTheDocument();
    }
  });

  it('draws a bar at the reported percent and a full bar for a finished job', () => {
    renderRows([
      row({ id: 'a', name: 'running', status: 'active', progress: 40 }),
      row({ id: 'b', name: 'done', status: 'completed', progress: 0 }),
    ]);
    expect(within(screen.getByRole('row', { name: /running/ })).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    expect(within(screen.getByRole('row', { name: /done/ })).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('draws no bar, not a 0% bar, when progress is 0, missing or not a number', () => {
    renderRows([
      row({ id: 'a', name: 'zero', status: 'active', progress: 0 }),
      row({ id: 'b', name: 'null', status: 'active', progress: null as unknown as number }),
      row({ id: 'c', name: 'nan', status: 'waiting', progress: Number.NaN }),
    ]);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('says there are no jobs instead of drawing an empty table', () => {
    renderRows([]);
    expect(screen.getByText('No jobs found')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('names the rows-per-page control and reports the chosen size', async () => {
    const onRowsPerPageChange = vi.fn();
    render(
      <JobList
        jobs={jobs(2)}
        hasMore={false}
        page={0}
        rowsPerPage={ROWS_PER_PAGE}
        onPageChange={vi.fn()}
        onRowsPerPageChange={onRowsPerPageChange}
        onViewDetails={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Rows per page' }), '50');
    expect(onRowsPerPageChange).toHaveBeenCalledWith(50);
  });
});
