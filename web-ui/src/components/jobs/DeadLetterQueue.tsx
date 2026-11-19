// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * DeadLetterQueue Component
 *
 * Viewer for dead letter queue jobs that have exhausted all retry attempts.
 */

import React, { useState, useEffect } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  Disclosure,
  EmptyState,
  Eyebrow,
  Icon,
} from '@happy-technologies/design-system';
import { format } from 'date-fns';
import { QueryState } from '../estate/SurfaceState';
import { Job, jobsService } from '../../services/jobs.service';

interface DeadLetterQueueProps {
  queueName: string;
}

export const DeadLetterQueue: React.FC<DeadLetterQueueProps> = ({ queueName }) => {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const fetchDeadLetterJobs = async () => {
    try {
      setLoading(true);
      setError(null);
      const deadJobs = await jobsService.getDeadLetterJobs(queueName);
      setJobs(deadJobs);
    } catch (err) {
      setError(err ?? new Error('Failed to fetch dead letter jobs'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDeadLetterJobs();
  }, [queueName]);

  const formatTimestamp = (timestamp: number): string => {
    return format(new Date(timestamp), 'yyyy-MM-dd HH:mm:ss');
  };

  if (loading || error) {
    return (
      <QueryState
        what="dead letter jobs"
        loading={loading}
        error={error}
        onRetry={fetchDeadLetterJobs}
      />
    );
  }

  if (jobs.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No dead letter jobs"
          description="All failed jobs have been processed or retried successfully"
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <Banner tone="neutral" className="flex-grow">
          Dead letter queue contains {jobs.length} job{jobs.length !== 1 ? 's' : ''} that have
          exhausted all retry attempts. These jobs require manual intervention.
        </Banner>
        <Button variant="secondary" icon="arrow-clockwise" onClick={fetchDeadLetterJobs}>
          Refresh
        </Button>
      </div>

      <div className="space-y-2">
        {jobs.map((job) => (
          <Card key={job.id} inset="none" className="px-4">
            <Disclosure
              title={
                <span className="flex items-center gap-3">
                  <Icon name="x-circle" size={20} className="flex-none text-[var(--hh-error-text)]" />
                  <span className="min-w-0 flex-grow">
                    <span className="block text-sm font-medium">{job.name}</span>
                    <span className="block text-xs font-normal text-[var(--hh-text-muted)]">
                      Failed at: {formatTimestamp(job.finishedOn || job.timestamp)}
                    </span>
                  </span>
                  <Badge variant="danger">
                    {job.attempts}/{job.maxAttempts} attempts
                  </Badge>
                </span>
              }
            >
              <div className="space-y-2">
                <Eyebrow tone="danger">Error Message</Eyebrow>
                <Banner tone="danger">{job.failedReason || 'No error message available'}</Banner>
              </div>
            </Disclosure>
          </Card>
        ))}
      </div>
    </div>
  );
};
