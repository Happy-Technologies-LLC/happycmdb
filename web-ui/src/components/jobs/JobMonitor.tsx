// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * JobMonitor Component
 *
 * Real-time job monitoring dashboard showing active jobs across all queues.
 */

import React, { useState } from 'react';
import { Banner, Card, NativeSelect, Tabs } from '@happy-technologies/design-system';
import { QueryState } from '../estate/SurfaceState';
import { useJobs } from '../../hooks/useJobs';
import { Job, JobFilters } from '../../services/jobs.service';
import { JobList } from './JobList';
import { JobDetail } from './JobDetail';

interface JobMonitorProps {
  autoRefresh?: boolean;
  refreshInterval?: number;
}

const QUEUE_NAMES = [
  'discovery-aws',
  'discovery-azure',
  'discovery-gcp',
  'discovery-ssh',
  'discovery-nmap',
  'etl-sync',
  'etl-change-detection',
  'etl-reconciliation',
  'etl-full-refresh',
];

export const JobMonitor: React.FC<JobMonitorProps> = ({
  autoRefresh = true,
  refreshInterval = 5000,
}) => {
  const [statusTab, setStatusTab] = useState<'active' | 'waiting' | 'delayed'>('active');
  const [queueFilter, setQueueFilter] = useState<string>(QUEUE_NAMES[0]);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  // Prepare filters based on current selections
  const filters: JobFilters = {
    status: statusTab,
    limit: rowsPerPage,
    offset: page * rowsPerPage,
  };

  // Fetch data with auto-refresh
  const {
    jobs,
    hasMore,
    loading: jobsLoading,
    error: jobsError,
    refetch: refetchJobs,
    retryJob,
    cancelJob,
  } = useJobs({
    queueName: queueFilter,
    filters,
    autoRefresh,
    refreshInterval,
  });

  // Global queue metrics and health are refused for every tenant role.

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
  };

  const handleRowsPerPageChange = (newRowsPerPage: number) => {
    setRowsPerPage(newRowsPerPage);
    setPage(0); // Reset to first page
  };

  const handleViewDetails = (job: Job) => {
    setSelectedJob(job);
  };

  const handleCloseDetails = () => {
    setSelectedJob(null);
  };

  const handleRetry = async (jobId: string) => {
    await retryJob(jobId);
    if (selectedJob?.id === jobId) {
      setSelectedJob(null);
    }
  };

  const handleCancel = async (jobId: string) => {
    await cancelJob(jobId);
    if (selectedJob?.id === jobId) {
      setSelectedJob(null);
    }
  };


  return (
    <div className="space-y-6">
      <Banner tone="neutral">
        Global queue and schedule controls are unavailable (platform operations only).
      </Banner>
      {/* Job Filters */}
      <Card inset="none" className="p-4">
        <div className="flex items-center gap-4">
          <div className="flex-grow">
            <Tabs
              aria-label="Job status"
              value={statusTab}
              onChange={(v) => {
                setStatusTab(v);
                setPage(0);
              }}
              options={[
                { value: 'active', label: 'Active Jobs' },
                { value: 'waiting', label: 'Waiting Jobs' },
                { value: 'delayed', label: 'Delayed Jobs' },
              ]}
            />
          </div>
          <div className="w-64">
            <NativeSelect
              size="sm"
              aria-label="Queue Filter"
              value={queueFilter}
              onChange={(e) => {
                setQueueFilter(e.target.value);
                setPage(0);
              }}
            >
              <optgroup label="Discovery Queues">
                {QUEUE_NAMES.filter((q) => q.startsWith('discovery-')).map((queue) => (
                  <option key={queue} value={queue}>
                    {queue}
                  </option>
                ))}
              </optgroup>
              <optgroup label="ETL Queues">
                {QUEUE_NAMES.filter((q) => q.startsWith('etl-')).map((queue) => (
                  <option key={queue} value={queue}>
                    {queue}
                  </option>
                ))}
              </optgroup>
            </NativeSelect>
          </div>
        </div>
      </Card>

      {/* Job List */}
      {jobsError || (jobsLoading && jobs.length === 0) ? (
        <QueryState what="jobs" loading={!jobsError} error={jobsError} onRetry={refetchJobs} />
      ) : (
        <JobList
          jobs={jobs}
          hasMore={hasMore}
          page={page}
          rowsPerPage={rowsPerPage}
          onPageChange={handlePageChange}
          onRowsPerPageChange={handleRowsPerPageChange}
          onViewDetails={handleViewDetails}
          onRetry={handleRetry}
          onCancel={handleCancel}
          loading={jobsLoading}
        />
      )}

      {/* Job Detail Modal */}
      <JobDetail
        job={selectedJob}
        open={selectedJob !== null}
        onClose={handleCloseDetails}
        onRetry={handleRetry}
        onCancel={handleCancel}
      />

      {/* Auto-refresh indicator */}
      {autoRefresh && (
        <div className="mt-4 text-center">
          <p className="text-xs text-[var(--hh-text-muted)]">
            Auto-refreshing every {refreshInterval / 1000} seconds
          </p>
        </div>
      )}
    </div>
  );
};
