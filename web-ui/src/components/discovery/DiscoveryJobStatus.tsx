// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { DiscoveryJob, JobStatus } from '../../services/discovery.service';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Progress } from '../ui/progress';
import { Alert, AlertDescription } from '../ui/alert';
import { Separator } from '../ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import { Icon } from '@happy-technologies/design-system';

interface DiscoveryJobStatusProps {
  job: DiscoveryJob;
  onRetry?: (jobId: string) => void;
  onCancel?: (jobId: string) => void;
}

const STATUS_CONFIG: Record<JobStatus, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  pending: { variant: 'outline', label: 'Pending' },
  running: { variant: 'default', label: 'Running' },
  completed: { variant: 'secondary', label: 'Completed' },
  failed: { variant: 'destructive', label: 'Failed' },
  cancelled: { variant: 'outline', label: 'Cancelled' },
};

const formatDateTime = (dateString?: string): string => {
  if (!dateString) return 'N/A';
  return new Date(dateString).toLocaleString();
};

const formatDuration = (start?: string, end?: string): string => {
  if (!start) return 'N/A';
  const startTime = new Date(start).getTime();
  const endTime = end ? new Date(end).getTime() : Date.now();
  const diffMs = endTime - startTime;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);

  if (diffMins < 1) return `${diffSecs}s`;
  if (diffMins < 60) return `${diffMins}m ${diffSecs % 60}s`;
  const hours = Math.floor(diffMins / 60);
  return `${hours}h ${diffMins % 60}m`;
};

const redactCredentials = (config: Record<string, any>): Record<string, any> => {
  const redacted = { ...config };

  // Redact common credential fields
  const sensitiveFields = [
    'credentials',
    'accessKeyId',
    'secretAccessKey',
    'password',
    'apiKey',
    'token',
    'secret',
    'privateKey',
    'clientSecret',
  ];

  const redactObject = (obj: any): any => {
    if (!obj || typeof obj !== 'object') return obj;

    const result: any = Array.isArray(obj) ? [] : {};

    for (const key in obj) {
      const lowerKey = key.toLowerCase();
      const isArray = Array.isArray(obj);

      if (sensitiveFields.some(field => lowerKey.includes(field.toLowerCase()))) {
        result[key] = '***REDACTED***';
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        result[key] = redactObject(obj[key]);
      } else {
        result[key] = obj[key];
      }
    }

    return result;
  };

  return redactObject(redacted);
};

export const DiscoveryJobStatus: React.FC<DiscoveryJobStatusProps> = ({
  job,
  onRetry,
  onCancel,
}) => {
  const [logsExpanded, setLogsExpanded] = useState(false);
  const statusConfig = STATUS_CONFIG[job.status];

  return (
    <Card className="w-full">
      <CardContent className="space-y-4 w-full">
        <div className="flex justify-between items-start">
          <div>
            <h3 className="font-semibold">Job ID: {job.id}</h3>
            <p className="text-sm text-muted-foreground">
              Provider: {job.provider.toUpperCase()}
            </p>
          </div>
          <Badge variant={statusConfig.variant}>
            {statusConfig.label}
          </Badge>
        </div>

        {job.status === 'running' && (
          <div>
            <div className="flex justify-between mb-2">
              <span className="text-sm">Progress</span>
              <span className="text-sm">{job.progress}%</span>
            </div>
            <Progress value={job.progress} />
          </div>
        )}

        <div className="space-y-2">
          <div className="flex justify-between">
            <span className="text-sm text-muted-foreground">Discovered CIs:</span>
            <span className="text-sm font-medium">{job.discoveredCIs}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-muted-foreground">Created:</span>
            <span className="text-sm font-medium">{formatDateTime(job.createdAt)}</span>
          </div>
          {job.startedAt && (
            <div className="flex justify-between">
              <span className="text-sm text-muted-foreground">Started:</span>
              <span className="text-sm font-medium">{formatDateTime(job.startedAt)}</span>
            </div>
          )}
          {job.completedAt && (
            <div className="flex justify-between">
              <span className="text-sm text-muted-foreground">Completed:</span>
              <span className="text-sm font-medium">{formatDateTime(job.completedAt)}</span>
            </div>
          )}
          {job.startedAt && (
            <div className="flex justify-between">
              <span className="text-sm text-muted-foreground">Duration:</span>
              <span className="text-sm font-medium">
                {formatDuration(job.startedAt, job.completedAt)}
              </span>
            </div>
          )}
        </div>

        {job.error && (
          <Alert variant="destructive">
            <AlertDescription>{job.error}</AlertDescription>
          </Alert>
        )}

        <Separator />

        <div className="flex gap-2 flex-wrap">
          {job.status === 'failed' && onRetry && (
            <Button
              size="sm"
              onClick={() => onRetry(job.id)}
            >
              <Icon name="arrows-clockwise" size={16} className="mr-2" />
              Retry
            </Button>
          )}
          {job.status === 'running' && onCancel && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => onCancel(job.id)}
            >
              <Icon name="x" size={16} className="mr-2" />
              Cancel
            </Button>
          )}
          <Collapsible open={logsExpanded} onOpenChange={setLogsExpanded}>
            <CollapsibleTrigger asChild>
              <Button size="sm" variant="ghost">
                {logsExpanded ? 'Hide' : 'Show'} Logs
                <Icon
                  name="caret-down"
                  size={16}
                  className={`ml-2 transition-transform ${
                    logsExpanded ? 'rotate-180' : ''
                  }`}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-4 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2">
              <Card className="w-full">
                <CardContent className="pt-6 w-full">
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Job ID</p>
                      <p className="text-sm font-mono">{job.id}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Provider</p>
                      <p className="text-sm font-semibold">{job.provider.toUpperCase()}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Status</p>
                      <Badge variant={STATUS_CONFIG[job.status].variant}>
                        {STATUS_CONFIG[job.status].label}
                      </Badge>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Progress</p>
                      <p className="text-sm font-semibold">{job.progress}%</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Discovered CIs</p>
                      <p className="text-sm font-semibold">{job.discoveredCIs}</p>
                    </div>
                    {job.definitionName && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Definition</p>
                        <p className="text-sm">{job.definitionName}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">Created At</p>
                      <p className="text-sm">{formatDateTime(job.createdAt)}</p>
                    </div>
                    {job.startedAt && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Started At</p>
                        <p className="text-sm">{formatDateTime(job.startedAt)}</p>
                      </div>
                    )}
                    {job.completedAt && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Completed At</p>
                        <p className="text-sm">{formatDateTime(job.completedAt)}</p>
                      </div>
                    )}
                  </div>

                  {job.error && (
                    <Alert variant="destructive" className="mb-4">
                      <AlertDescription>{job.error}</AlertDescription>
                    </Alert>
                  )}

                  {job.config && (
                    <>
                      <Separator className="my-4" />
                      <div>
                        <p className="text-sm font-semibold mb-3">Configuration</p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {Object.entries(redactCredentials(job.config)).map(([key, value]) => {
                            if (key === 'credentials' || key === 'jobId') return null;

                            return (
                              <div key={key}>
                                <p className="text-xs text-muted-foreground mb-1 capitalize">
                                  {key.replace(/([A-Z])/g, ' $1').trim()}
                                </p>
                                <p className="text-sm font-mono">
                                  {typeof value === 'object' && value !== null
                                    ? JSON.stringify(value)
                                    : String(value)}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </CardContent>
    </Card>
  );
};

export default DiscoveryJobStatus;
