// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * JobList Component
 *
 * Paginated list of jobs with filtering and sorting capabilities.
 */

import React from 'react';
import { Icon } from '@happy-technologies/design-system';
import { format } from 'date-fns';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { Card } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Job } from '../../services/jobs.service';
import { JobProgress } from './JobProgress';
import { JobRetryButton } from './JobRetryButton';
import { JobCancelButton } from './JobCancelButton';

interface JobListProps {
  jobs: Job[];
  total: number;
  page: number;
  rowsPerPage: number;
  onPageChange: (page: number) => void;
  onRowsPerPageChange: (rowsPerPage: number) => void;
  onViewDetails: (job: Job) => void;
  onRetry: (jobId: string) => Promise<void>;
  onCancel: (jobId: string) => Promise<void>;
  loading?: boolean;
}

export const JobList: React.FC<JobListProps> = ({
  jobs,
  total,
  page,
  rowsPerPage,
  onPageChange,
  onRowsPerPageChange,
  onViewDetails,
  onRetry,
  onCancel,
  loading = false,
}) => {
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

  const getStatusColor = (status: Job['status']): 'default' | 'secondary' | 'destructive' | 'outline' => {
    switch (status) {
      case 'completed':
        return 'default';
      case 'failed':
        return 'destructive';
      case 'active':
        return 'default';
      case 'waiting':
      case 'delayed':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  const getQueueType = (queueName: string): 'discovery' | 'etl' => {
    return queueName.startsWith('discovery:') ? 'discovery' : 'etl';
  };

  if (jobs.length === 0 && !loading) {
    return (
      <div className="text-center py-16">
        <h3 className="text-lg font-semibold text-muted-foreground">
          No jobs found
        </h3>
        <p className="text-sm text-muted-foreground mt-2">
          Try adjusting your filters
        </p>
      </div>
    );
  }

  const totalPages = Math.ceil(total / rowsPerPage);

  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Job Name</TableHead>
            <TableHead>Queue</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Progress</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Attempts</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => (
            <TableRow key={job.id}>
              <TableCell>
                <div className="max-w-[200px] truncate text-sm">
                  {job.name}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="text-xs">
                  {job.queueName}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge
                  variant={getQueueType(job.queueName) === 'discovery' ? 'default' : 'secondary'}
                  className="text-xs"
                >
                  {getQueueType(job.queueName)}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant={getStatusColor(job.status)} className="text-xs">
                  {job.status}
                </Badge>
              </TableCell>
              <TableCell className="min-w-[120px]">
                <JobProgress job={job} showLabel={false} height={6} />
              </TableCell>
              <TableCell>
                <div className="text-sm whitespace-nowrap">
                  {formatTimestamp(job.timestamp)}
                </div>
              </TableCell>
              <TableCell>
                {job.processedOn && (
                  <div className="text-sm whitespace-nowrap">
                    {formatDuration(job.processedOn, job.finishedOn)}
                  </div>
                )}
              </TableCell>
              <TableCell>
                <div className="text-sm">
                  {job.attempts} / {job.maxAttempts}
                </div>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex gap-1 justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onViewDetails(job)}
                    title="View Details"
                  >
                    <Icon name="eye" size={16} />
                  </Button>
                  {job.status === 'failed' && (
                    <JobRetryButton
                      job={job}
                      onRetry={onRetry}
                      variant="ghost"
                      size="sm"
                    />
                  )}
                  {(job.status === 'active' || job.status === 'waiting') && (
                    <JobCancelButton
                      job={job}
                      onCancel={onCancel}
                      variant="ghost"
                      size="sm"
                    />
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Pagination */}
      <div className="flex items-center justify-between px-4 py-3 border-t">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Rows per page:</span>
          <select
            className="border rounded px-2 py-1 text-sm"
            value={rowsPerPage}
            onChange={(e) => onRowsPerPageChange(Number(e.target.value))}
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            Page {page + 1} of {totalPages} ({total} total)
          </span>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page - 1)}
              disabled={page === 0}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages - 1}
            >
              Next
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
};
