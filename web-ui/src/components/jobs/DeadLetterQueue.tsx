// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * DeadLetterQueue Component
 *
 * Viewer for dead letter queue jobs that have exhausted all retry attempts.
 */

import React, { useState, useEffect } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { format } from 'date-fns';
import { Card, CardContent } from '../ui/card';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { Job, jobsService } from '../../services/jobs.service';

interface DeadLetterQueueProps {
  queueName: string;
}

export const DeadLetterQueue: React.FC<DeadLetterQueueProps> = ({ queueName }) => {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDeadLetterJobs = async () => {
    try {
      setLoading(true);
      setError(null);
      const deadJobs = await jobsService.getDeadLetterJobs(queueName);
      setJobs(deadJobs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch dead letter jobs');
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

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Icon name="spinner-gap" size={32} className="animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive" className="mb-4">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (jobs.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="text-center">
            <h3 className="text-lg font-semibold text-muted-foreground">
              No dead letter jobs
            </h3>
            <p className="text-sm text-muted-foreground mt-2">
              All failed jobs have been processed or retried successfully
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center gap-4">
        <Alert className="flex-grow">
          <AlertDescription>
            Dead letter queue contains {jobs.length} job{jobs.length !== 1 ? 's' : ''} that have
            exhausted all retry attempts. These jobs require manual intervention.
          </AlertDescription>
        </Alert>
        <Button
          variant="outline"
          onClick={fetchDeadLetterJobs}
          className="gap-1"
        >
          <Icon name="arrow-clockwise" size={16} />
          Refresh
        </Button>
      </div>

      <div className="space-y-2">
        {jobs.map((job) => (
          <Collapsible key={job.id}>
            <Card>
              <CollapsibleTrigger className="w-full">
                <CardContent className="p-4">
                  <div className="flex items-center w-full">
                    <Icon name="x-circle" size={20} className="text-destructive mr-3" />
                    <div className="flex-grow text-left">
                      <div className="font-medium text-sm">{job.name}</div>
                      <div className="text-xs text-muted-foreground">
                        Failed at: {formatTimestamp(job.finishedOn || job.timestamp)}
                      </div>
                    </div>
                    <Badge variant="destructive" className="mr-3">
                      {job.attempts}/{job.maxAttempts} attempts
                    </Badge>
                    <Icon name="caret-down" size={16} className="text-muted-foreground" />
                  </div>
                </CardContent>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="px-4 pb-4 pt-0 space-y-4">
                  <div>
                    <h4 className="text-sm font-semibold mb-2">Error Message</h4>
                    <Card className="bg-red-50 border-red-200">
                      <CardContent className="p-3">
                        <p className="text-sm text-red-900">
                          {job.failedReason || 'No error message available'}
                        </p>
                      </CardContent>
                    </Card>
                  </div>

                  {job.stacktrace && job.stacktrace.length > 0 && (
                    <div>
                      <h4 className="text-sm font-semibold mb-2">Stack Trace</h4>
                      <Card className="bg-muted">
                        <CardContent className="p-3 max-h-48 overflow-auto">
                          <pre className="text-xs font-mono whitespace-pre-wrap break-words">
                            {job.stacktrace.join('\n')}
                          </pre>
                        </CardContent>
                      </Card>
                    </div>
                  )}

                  <div>
                    <h4 className="text-sm font-semibold mb-2">Job Data</h4>
                    <Card className="bg-muted">
                      <CardContent className="p-3 max-h-48 overflow-auto">
                        <pre className="text-xs font-mono whitespace-pre-wrap break-words">
                          {JSON.stringify(job.data, null, 2)}
                        </pre>
                      </CardContent>
                    </Card>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        ))}
      </div>
    </div>
  );
};
