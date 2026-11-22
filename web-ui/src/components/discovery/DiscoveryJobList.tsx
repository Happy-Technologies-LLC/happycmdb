// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { DiscoveryJob, DiscoveryProvider, JobStatus } from '../../services/discovery.service';
import { useDiscoveryJobs } from '../../hooks/useDiscoveryJobs';
import DiscoveryJobStatus from './DiscoveryJobStatus';
import { useDiscovery } from '../../hooks/useDiscovery';
import {
  Badge,
  Banner,
  Button,
  DataTable,
  NativeSelect,
  Pagination,
  ProgressBar,
  type BadgeVariant,
  type Column,
} from '@happy-technologies/design-system';
import { QueryState } from '@/components/estate/SurfaceState';

const STATUS_CONFIG: Record<JobStatus, { variant: BadgeVariant; label: string }> = {
  pending: { variant: 'neutral', label: 'Pending' },
  running: { variant: 'info', label: 'Running' },
  completed: { variant: 'success', label: 'Completed' },
  failed: { variant: 'danger', label: 'Failed' },
  cancelled: { variant: 'neutral', label: 'Cancelled' },
};

const PROVIDERS: DiscoveryProvider[] = ['nmap', 'ssh', 'active-directory', 'snmp'];
const STATUSES: JobStatus[] = ['pending', 'running', 'completed', 'failed', 'cancelled'];

export const DiscoveryJobList: React.FC = () => {
  const {
    jobs,
    page,
    totalPages,
    loading,
    error,
    loadJobs,
    setFilters,
    setPage,
    filters,
  } = useDiscoveryJobs({}, true);

  const { retryJob, cancelJob } = useDiscovery();

  const handleProviderChange = (providers: string[]) => {
    setFilters({
      ...filters,
      provider: providers.length > 0 ? (providers[0] as DiscoveryProvider) : undefined,
    });
  };

  const handleStatusChange = (statuses: string[]) => {
    setFilters({
      ...filters,
      status: statuses.length > 0 ? (statuses[0] as JobStatus) : undefined,
    });
  };

  const handleDefinitionFilterChange = (value: string) => {
    setFilters({
      ...filters,
      definitionId: value === 'all' ? undefined : value,
    });
  };

  // Get unique definition names from jobs for filter
  const uniqueDefinitions = Array.from(
    new Map(
      jobs
        .filter((job) => job.definitionId && job.definitionName)
        .map((job) => [job.definitionId, job.definitionName])
    ).entries()
  ).map(([id, name]) => ({ id, name }));

  const columns: Array<Column<DiscoveryJob>> = [
    { header: 'Job ID', render: (job) => <span className="hh-mono text-sm">{job.id}</span> },
    {
      header: 'Definition',
      render: (job) =>
        job.definitionName ? (
          <span className="text-sm font-medium">{job.definitionName}</span>
        ) : (
          <span className="text-sm italic text-[var(--hh-text-muted)]">Ad-hoc</span>
        ),
    },
    { header: 'Provider', render: (job) => <Badge variant="neutral">{job.provider.toUpperCase()}</Badge> },
    {
      header: 'Status',
      render: (job) => (
        <Badge variant={STATUS_CONFIG[job.status].variant} dot>
          {STATUS_CONFIG[job.status].label}
        </Badge>
      ),
    },
    {
      header: 'Progress',
      render: (job) => (
        <div className="flex w-full max-w-[150px] items-center gap-2">
          <ProgressBar value={job.progress} aria-label={`Progress of job ${job.id}`} />
          <span className="text-xs">{job.progress}%</span>
        </div>
      ),
    },
    // A job that reports no count shows a dash, not a zero.
    { header: 'CIs', render: (job) => <span className="text-sm font-medium">{job.discoveredCIs ?? '\u2013'}</span> },
    {
      header: 'Created',
      render: (job) => (
        <span className="text-sm text-[var(--hh-text-muted)]">{new Date(job.createdAt).toLocaleString()}</span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <NativeSelect
          size="sm"
          aria-label="Filter by provider"
          containerClassName="min-w-[150px]"
          value={filters.provider || 'all'}
          onChange={(e) => handleProviderChange(e.target.value === 'all' ? [] : [e.target.value])}
        >
          <option value="all">All Providers</option>
          {PROVIDERS.map((provider) => (
            <option key={provider} value={provider}>
              {provider.toUpperCase()}
            </option>
          ))}
        </NativeSelect>

        <NativeSelect
          size="sm"
          aria-label="Filter by status"
          containerClassName="min-w-[150px]"
          value={filters.status || 'all'}
          onChange={(e) => handleStatusChange(e.target.value === 'all' ? [] : [e.target.value])}
        >
          <option value="all">All Statuses</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_CONFIG[status].label}
            </option>
          ))}
        </NativeSelect>

        {uniqueDefinitions.length > 0 && (
          <NativeSelect
            size="sm"
            aria-label="Filter by definition"
            containerClassName="min-w-[200px]"
            value={filters.definitionId || 'all'}
            onChange={(e) => handleDefinitionFilterChange(e.target.value)}
          >
            <option value="all">All Definitions</option>
            {uniqueDefinitions.map((def) => (
              <option key={def.id} value={def.id || ''}>
                {def.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </div>

      {loading && jobs.length === 0 ? (
        <QueryState what="discovery jobs" loading />
      ) : error && jobs.length === 0 ? (
        <QueryState what="discovery jobs" error={new Error(error)} onRetry={loadJobs} />
      ) : (
        <>
          {error && (
            <Banner tone="danger" icon="warning-circle">
              Could not load discovery jobs: {error}{' '}
              <Button size="sm" variant="secondary" onClick={loadJobs}>
                Try again
              </Button>
            </Banner>
          )}
          <DataTable
            rows={jobs}
            columns={columns}
            rowKey={(job) => job.id}
            emptyLabel="No jobs found"
            caption="Discovery jobs"
            renderExpanded={(job) => (
              <DiscoveryJobStatus job={job} onRetry={retryJob} onCancel={cancelJob} />
            )}
            footer={
              totalPages > 1 ? (
                <Pagination page={page} pageCount={totalPages} onChange={setPage} />
              ) : undefined
            }
          />
        </>
      )}
    </div>
  );
};

export default DiscoveryJobList;
