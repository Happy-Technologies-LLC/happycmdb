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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card, CardContent } from '../ui/card';
import { Alert, AlertDescription } from '../ui/alert';
import { Separator } from '../ui/separator';
import { Job } from '../../services/jobs.service';
import { JobProgress } from './JobProgress';
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

  const getStatusColor = (): 'default' | 'secondary' | 'destructive' | 'outline' => {
    switch (job.status) {
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

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Job Details</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">{job.name}</h2>
              <Badge variant={getStatusColor()}>
                {job.status.toUpperCase()}
              </Badge>
            </div>
            <JobProgress job={job} />
          </div>

          <Separator />

          <div>
            <h3 className="text-sm font-semibold mb-2">Job Information</h3>
            <Card>
              <CardContent className="p-4 bg-muted">
                <div className="grid grid-cols-[150px_1fr] gap-2 text-sm">
                  <span className="text-muted-foreground">ID:</span>
                  <span className="font-mono">{job.id}</span>

                  <span className="text-muted-foreground">Queue:</span>
                  <span>{job.queueName}</span>

                  <span className="text-muted-foreground">Created:</span>
                  <span>{formatTimestamp(job.timestamp)}</span>

                  {job.processedOn && (
                    <>
                      <span className="text-muted-foreground">Started:</span>
                      <span>{formatTimestamp(job.processedOn)}</span>
                    </>
                  )}

                  {job.finishedOn && (
                    <>
                      <span className="text-muted-foreground">Finished:</span>
                      <span>{formatTimestamp(job.finishedOn)}</span>
                    </>
                  )}

                  {job.processedOn && (
                    <>
                      <span className="text-muted-foreground">Duration:</span>
                      <span>{formatDuration(job.processedOn, job.finishedOn)}</span>
                    </>
                  )}

                  <span className="text-muted-foreground">Attempts:</span>
                  <span>
                    {job.attempts} / {job.maxAttempts}
                  </span>

                  {job.delay && (
                    <>
                      <span className="text-muted-foreground">Delay:</span>
                      <span>{job.delay}ms</span>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {job.failedReason && (
            <div>
              <h3 className="text-sm font-semibold mb-2">Error Message</h3>
              <Alert variant="destructive">
                <AlertDescription>{job.failedReason}</AlertDescription>
              </Alert>
            </div>
          )}

          {job.stacktrace && job.stacktrace.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-2">Stack Trace</h3>
              <Card>
                <CardContent className="p-4 bg-muted max-h-48 overflow-auto">
                  <pre className="text-xs font-mono whitespace-pre-wrap break-words">
                    {job.stacktrace.join('\n')}
                  </pre>
                </CardContent>
              </Card>
            </div>
          )}

          <div>
            <h3 className="text-sm font-semibold mb-2">Job Data</h3>
            <Card>
              <CardContent className="p-4 bg-muted max-h-72 overflow-auto">
                <pre className="text-xs font-mono whitespace-pre-wrap break-words">
                  {JSON.stringify(job.data, null, 2)}
                </pre>
              </CardContent>
            </Card>
          </div>

          {Boolean(job.returnvalue) && (
            <div>
              <h3 className="text-sm font-semibold mb-2">Return Value</h3>
              <Card>
                <CardContent className="p-4 bg-muted max-h-48 overflow-auto">
                  <pre className="text-xs font-mono whitespace-pre-wrap break-words">
                    {JSON.stringify(job.returnvalue, null, 2)}
                  </pre>
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        <DialogFooter>
          <div className="flex gap-2 flex-grow">
            {job.status === 'failed' && (
              <JobRetryButton
                job={job}
                onRetry={onRetry}
                variant="default"
              />
            )}
            {(job.status === 'active' || job.status === 'waiting') && (
              <JobCancelButton
                job={job}
                onCancel={onCancel}
                variant="outline"
              />
            )}
          </div>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
