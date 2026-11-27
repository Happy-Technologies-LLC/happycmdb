// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { DiscoveryJob, DiscoveryProvider, JobStatus } from '../../services/discovery.service';
import {
  Badge,
  Banner,
  Button,
  Card,
  Disclosure,
  FieldList,
  ProgressBar,
  SectionHeading,
  Separator,
  type BadgeVariant,
} from '@happy-technologies/design-system';

interface DiscoveryJobStatusProps {
  job: DiscoveryJob;
  onRetry?: (jobId: string, provider: DiscoveryProvider) => void;
  onCancel?: (jobId: string) => void;
}

const STATUS_CONFIG: Record<JobStatus, { variant: BadgeVariant; label: string }> = {
  pending: { variant: 'neutral', label: 'Pending' },
  running: { variant: 'info', label: 'Running' },
  completed: { variant: 'success', label: 'Completed' },
  failed: { variant: 'danger', label: 'Failed' },
  cancelled: { variant: 'neutral', label: 'Cancelled' },
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
  const statusBadge = (
    <Badge variant={statusConfig.variant} dot>
      {statusConfig.label}
    </Badge>
  );

  return (
    <Card className="w-full space-y-4">
      <div>
        <SectionHeading level={3} className="mb-1" right={statusBadge}>
          Job ID: {job.id}
        </SectionHeading>
        <p className="text-sm text-[var(--hh-text-muted)]">Provider: {job.provider.toUpperCase()}</p>
      </div>

      {job.status === 'running' && (
        <div>
          <div className="mb-2 flex justify-between">
            <span className="text-sm">Progress</span>
            <span className="text-sm">{job.progress}%</span>
          </div>
          <ProgressBar value={job.progress} aria-label={`Progress of job ${job.id}`} />
        </div>
      )}

      <FieldList
        fields={[
          ['Discovered CIs', job.discoveredCIs],
          ['Created', formatDateTime(job.createdAt)],
          ['Started', job.startedAt ? formatDateTime(job.startedAt) : null],
          ['Completed', job.completedAt ? formatDateTime(job.completedAt) : null],
          ['Duration', job.startedAt ? formatDuration(job.startedAt, job.completedAt) : null],
        ]}
      />

      {job.error && <Banner tone="danger">{job.error}</Banner>}

      <Separator />

      <div className="flex flex-wrap gap-2">
        {job.status === 'failed' && onRetry && (
          <Button icon="arrows-clockwise" onClick={() => onRetry(job.id, job.provider)}>
            Retry
          </Button>
        )}
        {job.status === 'running' && onCancel && (
          <Button variant="danger" icon="x" onClick={() => onCancel(job.id)}>
            Cancel
          </Button>
        )}
      </div>

      <Disclosure
        title={`${logsExpanded ? 'Hide' : 'Show'} Logs`}
        open={logsExpanded}
        onOpenChange={setLogsExpanded}
      >
        {logsExpanded && (
          <div className="space-y-4 pt-2">
            <FieldList
              fields={[
                ['Job ID', <span key="id" className="hh-mono">{job.id}</span>],
                ['Provider', job.provider.toUpperCase()],
                ['Status', statusBadge],
                ['Progress', `${job.progress}%`],
                ['Discovered CIs', job.discoveredCIs],
                ['Definition', job.definitionName],
                ['Created At', formatDateTime(job.createdAt)],
                ['Started At', job.startedAt ? formatDateTime(job.startedAt) : null],
                ['Completed At', job.completedAt ? formatDateTime(job.completedAt) : null],
              ]}
            />

            {job.error && <Banner tone="danger">{job.error}</Banner>}

            {job.config && (
              <>
                <Separator />
                <div>
                  <p className="mb-3 text-sm font-semibold">Configuration</p>
                  <FieldList
                    fields={Object.entries(redactCredentials(job.config))
                      .filter(([key]) => key !== 'credentials' && key !== 'jobId')
                      .map(([key, value]): [string, React.ReactNode] => [
                        key.replace(/([A-Z])/g, ' $1').trim().replace(/\b\w/g, (c) => c.toUpperCase()),
                        <span className="hh-mono">
                          {typeof value === 'object' && value !== null
                            ? JSON.stringify(value)
                            : String(value)}
                        </span>,
                      ])}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </Disclosure>
    </Card>
  );
};

export default DiscoveryJobStatus;
