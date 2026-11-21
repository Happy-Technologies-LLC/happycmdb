// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * JobDetail Component
 *
 * Modal dialog showing detailed job information including data, logs, and error messages.
 */

import React from 'react';
import { format } from 'date-fns';
import {
  Badge,
  Banner,
  Button,
  Dialog,
  Eyebrow,
  FieldList,
  SectionHeading,
  Separator,
} from '@happy-technologies/design-system';
import { Job } from '../../services/jobs.service';
import { JobProgress, jobStatusVariant } from './JobProgress';
import { JobRetryButton } from './JobRetryButton';
import { JobCancelButton } from './JobCancelButton';

interface JobDetailProps {
  job: Job | null;
  open: boolean;
  onClose: () => void;
  onRetry: (jobId: string) => Promise<void>;
  onCancel: (jobId: string) => Promise<void>;
}

export const JobDetail: React.FC<JobDetailProps> = ({
  job,
  open,
  onClose,
  onRetry,
  onCancel,
}) => {
  if (!job) return null;

  const formatTimestamp = (timestamp: number): string => {
    return format(new Date(timestamp), 'yyyy-MM-dd HH:mm:ss');
  };

  const formatDuration = (start: number, end?: number): string => {
    const duration = (end || Date.now()) - start;
    const seconds = Math.floor(duration / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  };

  return (
    <Dialog open={open} onClose={onClose} aria-label="Job Details" className="max-w-3xl">
      <div className="max-h-[90vh] space-y-4 overflow-y-auto p-6">
        <SectionHeading className="mb-0 pr-8">Job Details</SectionHeading>

        <div>
          <SectionHeading
            level={3}
            right={
              <Badge variant={jobStatusVariant(job.status)} dot>
                {job.status.toUpperCase()}
              </Badge>
            }
          >
            {job.name}
          </SectionHeading>
          <JobProgress job={job} />
        </div>

        <Separator />

        <div className="space-y-2">
          <Eyebrow>Job Information</Eyebrow>
          <FieldList
            fields={[
              ['ID', <span key="id" className="font-mono">{job.id}</span>],
              ['Queue', job.queueName],
              ['Created', formatTimestamp(job.timestamp)],
              ['Started', job.processedOn ? formatTimestamp(job.processedOn) : null],
              ['Finished', job.finishedOn ? formatTimestamp(job.finishedOn) : null],
              ['Duration', job.processedOn ? formatDuration(job.processedOn, job.finishedOn) : null],
              ['Attempts', `${job.attempts} / ${job.maxAttempts}`],
              ['Delay', job.delay ? `${job.delay}ms` : null],
            ]}
          />
        </div>

        {job.failedReason && (
          <div className="space-y-2">
            <Eyebrow tone="danger">Error Message</Eyebrow>
            <Banner tone="danger">{job.failedReason}</Banner>
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-grow gap-2">
            {job.status === 'failed' && (
              <JobRetryButton job={job} onRetry={onRetry} variant="default" />
            )}
            {(job.status === 'active' || job.status === 'waiting') && (
              <JobCancelButton job={job} onCancel={onCancel} variant="outline" />
            )}
          </div>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
