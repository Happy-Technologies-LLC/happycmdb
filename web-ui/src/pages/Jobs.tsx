// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Jobs Page
 *
 * Main jobs page with tabs for Active, Completed, Failed jobs, Schedules, and Worker Status.
 */

import React, { useState } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectGroup,
  SelectLabel,
} from '@/components/ui/select';
import { useJobs } from '../hooks/useJobs';
import {
  useQueueStats,
  useQueueHealth,
  useSchedules,
} from '../hooks/useQueueStats';
import { Job, JobFilters, QueueMetrics } from '../services/jobs.service';
import { JobMonitor } from '../components/jobs/JobMonitor';
import { JobList } from '../components/jobs/JobList';
import { JobDetail } from '../components/jobs/JobDetail';
import { WorkerStatus } from '../components/jobs/WorkerStatus';
import { ScheduleList } from '../components/jobs/ScheduleList';
import { DeadLetterQueue } from '../components/jobs/DeadLetterQueue';

type TabValue = 'monitor' | 'completed' | 'failed' | 'schedules' | 'workers' | 'dead-letter';

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

export const Jobs: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabValue>('monitor');
  const [queueFilter, setQueueFilter] = useState<string>('all');
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  // Fetch queue health
  const {
    health,
    loading: healthLoading,
    error: healthError,
    pauseQueue,
    resumeQueue,
  } = useQueueHealth({
    autoRefresh: true,
    refreshInterval: 30000,
  });

  // Fetch schedules
  const {
    schedules,
    loading: schedulesLoading,
    error: schedulesError,
    toggleSchedule,
    refetch: refetchSchedules,
  } = useSchedules({
    autoRefresh: activeTab === 'schedules',
    refreshInterval: 60000,
  });

  // Fetch completed jobs
  const completedFilters: JobFilters = {
    status: 'completed',
    queueName: queueFilter !== 'all' ? queueFilter : undefined,
    limit: rowsPerPage,
    offset: page * rowsPerPage,
  };

  const {
    jobs: completedJobs,
    total: completedTotal,
    loading: completedLoading,
    error: completedError,
    refetch: refetchCompleted,
    retryJob: retryCompletedJob,
    cancelJob: cancelCompletedJob,
  } = useJobs({
    filters: completedFilters,
    autoRefresh: activeTab === 'completed',
    refreshInterval: 30000,
  });

  // Fetch failed jobs
  const failedFilters: JobFilters = {
    status: 'failed',
    queueName: queueFilter !== 'all' ? queueFilter : undefined,
    limit: rowsPerPage,
    offset: page * rowsPerPage,
  };

  const {
    jobs: failedJobs,
    total: failedTotal,
    loading: failedLoading,
    error: failedError,
    refetch: refetchFailed,
    retryJob: retryFailedJob,
    cancelJob: cancelFailedJob,
  } = useJobs({
    filters: failedFilters,
    autoRefresh: activeTab === 'failed',
    refreshInterval: 30000,
  });

  // Create queue metrics from health data for WorkerStatus
  const queueMetrics: QueueMetrics[] = health.map((h) => ({
    queueName: h.queueName,
    throughput: {
      completed: 0,
      failed: 0,
      timeWindow: '1h',
    },
    latency: {
      avg: h.avgProcessingTime,
      p50: h.avgProcessingTime,
      p95: h.avgProcessingTime * 1.5,
      p99: h.avgProcessingTime * 2,
    },
    workers: {
      active: h.workers,
      total: h.workers,
      concurrency: 5,
    },
  }));

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
      case 'schedules':
        refetchSchedules();
        break;
    }
  };

  const getTabBadge = (tab: TabValue): number | undefined => {
    if (tab === 'failed') return failedTotal;
    if (tab === 'schedules') return schedules.filter((s) => s.enabled).length;
    return undefined;
  };

  return (
    <div>
      {/* Breadcrumbs */}
      <nav className="flex mb-4" aria-label="Breadcrumb">
        <ol className="inline-flex items-center space-x-1 md:space-x-3">
          <li className="inline-flex items-center">
            <a href="/" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-foreground">
              <Icon name="house" size={16} className="mr-2" />
              Home
            </a>
          </li>
          <li>
            <div className="flex items-center">
              <span className="mx-2 text-muted-foreground">/</span>
              <span className="text-sm font-medium">Jobs</span>
            </div>
          </li>
        </ol>
      </nav>

      {/* Page Header */}
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">
          Job Monitoring
        </h1>
        <div className="flex gap-2 items-center">
          <Select value={queueFilter} onValueChange={setQueueFilter}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Queue Filter" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Queues</SelectItem>
              <SelectGroup>
                <SelectLabel>Discovery Queues</SelectLabel>
                {QUEUE_NAMES.filter((q) => q.startsWith('discovery:')).map((queue) => (
                  <SelectItem key={queue} value={queue}>
                    {queue}
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>ETL Queues</SelectLabel>
                {QUEUE_NAMES.filter((q) => q.startsWith('etl:')).map((queue) => (
                  <SelectItem key={queue} value={queue}>
                    {queue}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {activeTab !== 'monitor' && activeTab !== 'workers' && (
            <Button variant="outline" onClick={handleRefresh}>
              <Icon name="arrows-clockwise" size={16} className="mr-2" />
              Refresh
            </Button>
          )}
        </div>
      </div>

      {/* Error Alerts */}
      {healthError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>
            Failed to load queue health: {healthError.message}
          </AlertDescription>
        </Alert>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabValue)} className="w-full">
        <Card className="mb-6">
          <TabsList className="w-full justify-start overflow-x-auto flex-nowrap">
            <TabsTrigger value="monitor" className="gap-2">
              Monitor
            </TabsTrigger>
            <TabsTrigger value="completed" className="gap-2">
              Completed
              {completedTotal > 0 && (
                <Badge variant="success" className="ml-1">{completedTotal}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="failed" className="gap-2">
              Failed
              {failedTotal > 0 && (
                <Badge variant="destructive" className="ml-1">{failedTotal}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="schedules" className="gap-2">
              Schedules
              {getTabBadge('schedules') !== undefined && getTabBadge('schedules')! > 0 && (
                <Badge variant="info" className="ml-1">{getTabBadge('schedules')}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="workers">Worker Status</TabsTrigger>
            <TabsTrigger value="dead-letter">Dead Letter</TabsTrigger>
          </TabsList>
        </Card>

        {/* Tab Content */}
        <TabsContent value="monitor" className="mt-0">
          <JobMonitor autoRefresh={true} refreshInterval={5000} />
        </TabsContent>

        <TabsContent value="completed" className="mt-0">
          {completedError ? (
            <Alert variant="destructive">
              <AlertDescription>
                Failed to load completed jobs: {completedError.message}
              </AlertDescription>
            </Alert>
          ) : completedLoading && completedJobs.length === 0 ? (
            <div className="flex justify-center py-8">
              <Icon name="arrows-clockwise" size={32} className="animate-spin text-muted-foreground" />
            </div>
          ) : (
            <JobList
              jobs={completedJobs}
              total={completedTotal}
              page={page}
              rowsPerPage={rowsPerPage}
              onPageChange={handlePageChange}
              onRowsPerPageChange={handleRowsPerPageChange}
              onViewDetails={handleViewDetails}
              onRetry={handleRetry}
              onCancel={handleCancel}
              loading={completedLoading}
            />
          )}
        </TabsContent>

        <TabsContent value="failed" className="mt-0">
          {failedError ? (
            <Alert variant="destructive">
              <AlertDescription>
                Failed to load failed jobs: {failedError.message}
              </AlertDescription>
            </Alert>
          ) : failedLoading && failedJobs.length === 0 ? (
            <div className="flex justify-center py-8">
              <Icon name="arrows-clockwise" size={32} className="animate-spin text-muted-foreground" />
            </div>
          ) : (
            <JobList
              jobs={failedJobs}
              total={failedTotal}
              page={page}
              rowsPerPage={rowsPerPage}
              onPageChange={handlePageChange}
              onRowsPerPageChange={handleRowsPerPageChange}
              onViewDetails={handleViewDetails}
              onRetry={handleRetry}
              onCancel={handleCancel}
              loading={failedLoading}
            />
          )}
        </TabsContent>

        <TabsContent value="schedules" className="mt-0">
          {schedulesError ? (
            <Alert variant="destructive">
              <AlertDescription>
                Failed to load schedules: {schedulesError.message}
              </AlertDescription>
            </Alert>
          ) : (
            <ScheduleList
              schedules={schedules}
              loading={schedulesLoading}
              onToggle={toggleSchedule}
            />
          )}
        </TabsContent>

        <TabsContent value="workers" className="mt-0">
          <WorkerStatus
            metrics={queueMetrics}
            health={health}
            loading={healthLoading}
            onPauseQueue={pauseQueue}
            onResumeQueue={resumeQueue}
          />
        </TabsContent>

        <TabsContent value="dead-letter" className="mt-0">
          <DeadLetterQueue
            queueName={queueFilter !== 'all' ? queueFilter : QUEUE_NAMES[0]}
          />
        </TabsContent>
      </Tabs>

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
