// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * JobMonitor Component
 *
 * Real-time job monitoring dashboard showing active jobs across all queues.
 */

import React, { useState } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Label } from '../ui/label';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Card, CardContent } from '../ui/card';
import { useJobs } from '../../hooks/useJobs';
import { useQueueStats, useQueueHealth } from '../../hooks/useQueueStats';
import { Job, JobFilters } from '../../services/jobs.service';
import { QueueStats } from './QueueStats';
import { JobList } from './JobList';
import { JobDetail } from './JobDetail';

interface JobMonitorProps {
  autoRefresh?: boolean;
  refreshInterval?: number;
}

const QUEUE_NAMES = [
  'discovery:aws',
  'discovery:azure',
  'discovery:gcp',
  'discovery:ssh',
  'discovery:nmap',
  'etl:sync',
  'etl:change-detection',
  'etl:reconciliation',
  'etl:full-refresh',
];

export const JobMonitor: React.FC<JobMonitorProps> = ({
  autoRefresh = true,
  refreshInterval = 5000,
}) => {
  const [statusTab, setStatusTab] = useState<'active' | 'waiting' | 'delayed'>('active');
  const [queueFilter, setQueueFilter] = useState<string>('all');
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  // Prepare filters based on current selections
  const filters: JobFilters = {
    status: statusTab,
    queueName: queueFilter !== 'all' ? queueFilter : undefined,
    limit: rowsPerPage,
    offset: page * rowsPerPage,
  };

  // Fetch data with auto-refresh
  const {
    jobs,
    total,
    loading: jobsLoading,
    error: jobsError,
    refetch: refetchJobs,
    retryJob,
    cancelJob,
  } = useJobs({
    filters,
    autoRefresh,
    refreshInterval,
  });

  const {
    stats,
    loading: statsLoading,
    error: statsError,
  } = useQueueStats({
    autoRefresh,
    refreshInterval: 30000, // 30 seconds for stats
  });

  const {
    health,
    loading: healthLoading,
    error: healthError,
  } = useQueueHealth({
    autoRefresh,
    refreshInterval: 30000, // 30 seconds for health
  });

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

  // Count unhealthy queues
  const unhealthyQueues = health.filter(
    (h) => h.status === 'unhealthy' || h.status === 'degraded'
  ).length;

  return (
    <div className="space-y-6">
      {/* Queue Statistics */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Queue Overview</h2>
        <QueueStats
          stats={stats}
          loading={statsLoading}
          queueFilter={queueFilter !== 'all' ? queueFilter : undefined}
        />
      </div>

      {/* Health Alerts */}
      {unhealthyQueues > 0 && (
        <Alert>
          <AlertTitle>Queue Health Warning</AlertTitle>
          <AlertDescription>
            {unhealthyQueues} queue{unhealthyQueues !== 1 ? 's' : ''} {unhealthyQueues !== 1 ? 'are' : 'is'} experiencing
            issues. Check the Worker Status tab for details.
          </AlertDescription>
        </Alert>
      )}

      {statsError && (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load queue statistics: {statsError.message}
          </AlertDescription>
        </Alert>
      )}

      {/* Job Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex gap-4 items-center">
            <div className="flex-grow">
              <Tabs value={statusTab} onValueChange={(v) => {
                setStatusTab(v as typeof statusTab);
                setPage(0);
              }}>
                <TabsList>
                  <TabsTrigger value="active">Active Jobs</TabsTrigger>
                  <TabsTrigger value="waiting">Waiting Jobs</TabsTrigger>
                  <TabsTrigger value="delayed">Delayed Jobs</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div className="w-64">
              <Label htmlFor="queue-filter" className="sr-only">Queue Filter</Label>
              <Select value={queueFilter} onValueChange={(v) => {
                setQueueFilter(v);
                setPage(0);
              }}>
                <SelectTrigger id="queue-filter">
                  <SelectValue placeholder="All Queues" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Queues</SelectItem>
                  <SelectItem value="discovery-header" disabled>
                    <em>Discovery Queues</em>
                  </SelectItem>
                  {QUEUE_NAMES.filter((q) => q.startsWith('discovery:')).map((queue) => (
                    <SelectItem key={queue} value={queue}>
                      {queue}
                    </SelectItem>
                  ))}
                  <SelectItem value="etl-header" disabled>
                    <em>ETL Queues</em>
                  </SelectItem>
                  {QUEUE_NAMES.filter((q) => q.startsWith('etl:')).map((queue) => (
                    <SelectItem key={queue} value={queue}>
                      {queue}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Job List */}
      {jobsError ? (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load jobs: {jobsError.message}
          </AlertDescription>
        </Alert>
      ) : jobsLoading && jobs.length === 0 ? (
        <div className="flex justify-center py-16">
          <Icon name="spinner-gap" size={32} className="animate-spin" />
        </div>
      ) : (
        <JobList
          jobs={jobs}
          total={total}
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
        <div className="text-center mt-4">
          <p className="text-xs text-muted-foreground">
            Auto-refreshing every {refreshInterval / 1000} seconds
          </p>
        </div>
      )}
    </div>
  );
};
