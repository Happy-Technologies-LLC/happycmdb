// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * JobList Component
 *
 * Paginated list of jobs with filtering and sorting capabilities.
 */

import React from 'react';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  IconButton,
  NativeSelect,
  type Column,
} from '@happy-technologies/design-system';
import { format } from 'date-fns';
import { Job } from '../../services/jobs.service';
import { JobProgress, jobStatusVariant } from './JobProgress';
import { JobRetryButton } from './JobRetryButton';
import { JobCancelButton } from './JobCancelButton';

interface JobListProps {
  jobs: Job[];
  hasMore: boolean;
  page: number;
  rowsPerPage: number;
  onPageChange: (page: number) => void;
  onRowsPerPageChange: (rowsPerPage: number) => void;
  onViewDetails: (job: Job) => void;
  onRetry: (jobId: string) => Promise<void>;
  onCancel: (jobId: string) => Promise<void>;
  loading?: boolean;
}

const formatTimestamp = (timestamp: number): string => {
  return format(new Date(timestamp), 'MMM dd, HH:mm:ss');
};

const formatDuration = (start: number, end?: number): string => {
  const duration = (end || Date.now()) - start;
  const seconds = Math.floor(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
};

const getQueueType = (queueName: string): 'discovery' | 'etl' => {
  return queueName.startsWith('discovery-') ? 'discovery' : 'etl';
};

export const JobList: React.FC<JobListProps> = ({
  jobs,
  hasMore,
  page,
  rowsPerPage,
  onPageChange,
  onRowsPerPageChange,
  onViewDetails,
  onRetry,
  onCancel,
  loading = false,
}) => {
  if (jobs.length === 0 && !loading) {
    return <EmptyState title="No jobs found" description="Try adjusting your filters" />;
  }

  const columns: Array<Column<Job>> = [
    {
      header: 'Job Name',
      render: (job) => (
        <span className="block max-w-[200px] truncate text-sm" title={job.name}>
          {job.name}
        </span>
      ),
    },
    { header: 'Queue', render: (job) => <Badge variant="neutral">{job.queueName}</Badge> },
    {
      header: 'Type',
      render: (job) => (
        <Badge variant={getQueueType(job.queueName) === 'discovery' ? 'info' : 'default'}>
          {getQueueType(job.queueName)}
        </Badge>
      ),
    },
    {
      header: 'Status',
      render: (job) => (
        <Badge variant={jobStatusVariant(job.status)} dot>
          {job.status}
        </Badge>
      ),
    },
    {
      header: 'Progress',
      className: 'min-w-[120px]',
      render: (job) => <JobProgress job={job} showLabel={false} height={6} />,
    },
    {
      header: 'Created',
      render: (job) => <span className="whitespace-nowrap text-sm">{formatTimestamp(job.timestamp)}</span>,
    },
    {
      header: 'Duration',
      render: (job) =>
        job.processedOn ? (
          <span className="whitespace-nowrap text-sm">{formatDuration(job.processedOn, job.finishedOn)}</span>
        ) : null,
    },
    {
      header: 'Attempts',
      render: (job) => (
        <span className="text-sm">
          {job.attempts} / {job.maxAttempts}
        </span>
      ),
    },
    {
      header: 'Actions',
      className: 'text-right',
      render: (job) => (
        <div className="flex justify-end gap-1">
          <IconButton
            icon="eye"
            variant="ghost"
            size="sm"
            shape="rounded"
            aria-label="View Details"
            title="View Details"
            onClick={() => onViewDetails(job)}
          />
          {job.status === 'failed' && (
            <JobRetryButton job={job} onRetry={onRetry} variant="ghost" size="sm" />
          )}
          {(job.status === 'active' || job.status === 'waiting') && (
            <JobCancelButton job={job} onCancel={onCancel} variant="ghost" size="sm" />
          )}
        </div>
      ),
    },
  ];

  return (
    <DataTable
      caption="Jobs"
      rows={jobs}
      columns={columns}
      rowKey={(job) => job.id}
      loading={loading}
      footer={
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--hh-text-muted)]">Rows per page:</span>
            <NativeSelect
              size="sm"
              aria-label="Rows per page"
              value={rowsPerPage}
              onChange={(e) => onRowsPerPageChange(Number(e.target.value))}
            >
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </NativeSelect>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--hh-text-muted)]">Page {page + 1}</span>
            <div className="flex gap-1">
              <Button variant="secondary" onClick={() => onPageChange(page - 1)} disabled={page === 0}>
                Previous
              </Button>
              <Button variant="secondary" onClick={() => onPageChange(page + 1)} disabled={!hasMore}>
                Next
              </Button>
            </div>
          </div>
        </div>
      }
    />
  );
};
