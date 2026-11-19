// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Jobs Page
 *
 * Main jobs page with tabs for Active, Completed, Failed jobs, Schedules, and Worker Status.
 */

import React, { useState } from 'react';
import {
  Banner,
  Breadcrumbs,
  Button,
  NativeSelect,
  PageHeader,
  Tabs,
} from '@happy-technologies/design-system';
import { QueryState } from '../components/estate/SurfaceState';
import { useJobs } from '../hooks/useJobs';
import { Job, JobFilters } from '../services/jobs.service';
import { JobMonitor } from '../components/jobs/JobMonitor';
import { JobList } from '../components/jobs/JobList';
import { JobDetail } from '../components/jobs/JobDetail';
import { DeadLetterQueue } from '../components/jobs/DeadLetterQueue';

type TabValue = 'monitor' | 'completed' | 'failed' | 'schedules' | 'workers' | 'dead-letter';

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

export const Jobs: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabValue>('monitor');
  const [queueFilter, setQueueFilter] = useState<string>(QUEUE_NAMES[0]);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);


  // Fetch completed jobs
  const completedFilters: JobFilters = {
    status: 'completed',
    limit: rowsPerPage,
    offset: page * rowsPerPage,
  };

  const {
    jobs: completedJobs,
    hasMore: completedHasMore,
    loading: completedLoading,
    error: completedError,
    refetch: refetchCompleted,
    retryJob: retryCompletedJob,
    cancelJob: cancelCompletedJob,
  } = useJobs({
    queueName: queueFilter,
    filters: completedFilters,
    autoRefresh: activeTab === 'completed',
    refreshInterval: 30000,
  });

  // Fetch failed jobs
  const failedFilters: JobFilters = {
    status: 'failed',
    limit: rowsPerPage,
    offset: page * rowsPerPage,
  };

  const {
    jobs: failedJobs,
    hasMore: failedHasMore,
    loading: failedLoading,
    error: failedError,
    refetch: refetchFailed,
    retryJob: retryFailedJob,
    cancelJob: cancelFailedJob,
  } = useJobs({
    queueName: queueFilter,
    filters: failedFilters,
    autoRefresh: activeTab === 'failed',
    refreshInterval: 30000,
  });


  const handlePageChange = (newPage: number) => {
    setPage(newPage);
  };

  const handleRowsPerPageChange = (newRowsPerPage: number) => {
    setRowsPerPage(newRowsPerPage);
    setPage(0);
  };

  const handleViewDetails = (job: Job) => {
    setSelectedJob(job);
  };

  const handleCloseDetails = () => {
    setSelectedJob(null);
  };

  const handleRetry = async (jobId: string) => {
    if (activeTab === 'completed') {
      await retryCompletedJob(jobId);
    } else if (activeTab === 'failed') {
      await retryFailedJob(jobId);
    }
    if (selectedJob?.id === jobId) {
      setSelectedJob(null);
    }
  };

  const handleCancel = async (jobId: string) => {
    if (activeTab === 'completed') {
      await cancelCompletedJob(jobId);
    } else if (activeTab === 'failed') {
      await cancelFailedJob(jobId);
    }
    if (selectedJob?.id === jobId) {
      setSelectedJob(null);
    }
  };

  const handleRefresh = () => {
    switch (activeTab) {
      case 'completed':
        refetchCompleted();
        break;
      case 'failed':
        refetchFailed();
        break;
    }
  };


  return (
    <div>
      <Breadcrumbs className="mb-4" items={[{ label: 'Home', href: '/' }, { label: 'Jobs' }]} />

      <PageHeader
        className="mb-6"
        eyebrow="Operations"
        title="Job Monitoring"
        actions={
          <>
            <NativeSelect
              size="sm"
              aria-label="Queue"
              value={queueFilter}
              onChange={(e) => setQueueFilter(e.target.value)}
              containerClassName="w-[200px]"
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
            {(activeTab === 'completed' || activeTab === 'failed') && (
              <Button variant="secondary" icon="arrows-clockwise" onClick={handleRefresh}>
                Refresh
              </Button>
            )}
          </>
        }
      />

      <Tabs
        aria-label="Job views"
        className="mb-6"
        value={activeTab}
        onChange={setActiveTab}
        options={[
          { value: 'monitor', label: 'Monitor' },
          { value: 'completed', label: 'Completed' },
          { value: 'failed', label: 'Failed' },
          { value: 'schedules', label: 'Schedules' },
          { value: 'workers', label: 'Worker Status' },
          { value: 'dead-letter', label: 'Dead Letter' },
        ]}
      />

      {activeTab === 'monitor' && <JobMonitor autoRefresh={true} refreshInterval={5000} />}

      {activeTab === 'completed' &&
        (completedError || (completedLoading && completedJobs.length === 0) ? (
          <QueryState
            what="completed jobs"
            loading={!completedError}
            error={completedError}
            onRetry={refetchCompleted}
          />
        ) : (
          <JobList
            jobs={completedJobs}
            hasMore={completedHasMore}
            page={page}
            rowsPerPage={rowsPerPage}
            onPageChange={handlePageChange}
            onRowsPerPageChange={handleRowsPerPageChange}
            onViewDetails={handleViewDetails}
            onRetry={handleRetry}
            onCancel={handleCancel}
            loading={completedLoading}
          />
        ))}

      {activeTab === 'failed' &&
        (failedError || (failedLoading && failedJobs.length === 0) ? (
          <QueryState
            what="failed jobs"
            loading={!failedError}
            error={failedError}
            onRetry={refetchFailed}
          />
        ) : (
          <JobList
            jobs={failedJobs}
            hasMore={failedHasMore}
            page={page}
            rowsPerPage={rowsPerPage}
            onPageChange={handlePageChange}
            onRowsPerPageChange={handleRowsPerPageChange}
            onViewDetails={handleViewDetails}
            onRetry={handleRetry}
            onCancel={handleCancel}
            loading={failedLoading}
          />
        ))}

      {(activeTab === 'schedules' || activeTab === 'workers') && (
        <Banner tone="neutral">
          Global queue and schedule controls are unavailable (platform operations only).
        </Banner>
      )}

      {activeTab === 'dead-letter' && <DeadLetterQueue queueName={queueFilter} />}

      {/* Job Detail Modal */}
      <JobDetail
        job={selectedJob}
        open={selectedJob !== null}
        onClose={handleCloseDetails}
        onRetry={handleRetry}
        onCancel={handleCancel}
      />
    </div>
  );
};

export default Jobs;
