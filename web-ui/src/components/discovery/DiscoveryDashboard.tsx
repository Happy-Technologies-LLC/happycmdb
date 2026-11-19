import React from 'react';
import { useDiscoveryJobs } from '../../hooks/useDiscoveryJobs';
import { DiscoveryJob, JobStatus } from '../../services/discovery.service';
import { useNavigate } from 'react-router-dom';
import { Badge, Card, DataTable, SectionHeading, type BadgeVariant, type Column } from '@happy-technologies/design-system';
import { QueryState } from '@/components/estate/SurfaceState';

const STATUS_CONFIG: Record<JobStatus, { variant: BadgeVariant; label: string }> = {
  pending: { variant: 'neutral', label: 'Pending' },
  running: { variant: 'info', label: 'Running' },
  completed: { variant: 'success', label: 'Completed' },
  failed: { variant: 'danger', label: 'Failed' },
  cancelled: { variant: 'neutral', label: 'Cancelled' },
};

export const DiscoveryDashboard: React.FC = () => {
  const navigate = useNavigate();
  const { jobs, loading, error, loadJobs } = useDiscoveryJobs({ limit: 5, sortBy: 'createdAt', sortOrder: 'desc' }, false);

  const columns: Array<Column<DiscoveryJob>> = [
    { header: 'Job ID', render: (job) => <span className="hh-mono text-sm">{job.id}</span> },
    { header: 'Provider', render: (job) => <Badge variant="neutral">{job.provider.toUpperCase()}</Badge> },
    {
      header: 'Status',
      render: (job) => (
        <Badge variant={STATUS_CONFIG[job.status].variant} dot>
          {STATUS_CONFIG[job.status].label}
        </Badge>
      ),
    },
    // A job that reports no count shows a dash, not a zero.
    { header: 'CIs Discovered', className: 'text-right', render: (job) => job.discoveredCIs ?? '\u2013' },
    { header: 'Created', render: (job) => new Date(job.createdAt).toLocaleString() },
  ];

  return (
    <div className="space-y-6">
      <div>
        <SectionHeading className="mb-2">Discovery Dashboard</SectionHeading>
        <p className="text-sm text-[var(--hh-text-muted)]">
          Monitor and manage multi-cloud discovery operations
        </p>
      </div>

      <Card>
        <SectionHeading level={3} className="mb-1">Discovery statistics unavailable</SectionHeading>
        <p className="text-sm text-[var(--hh-text-muted)]">
          Global discovery statistics and provider totals are unavailable while tenant-safe reporting is being established.
        </p>
      </Card>

      <div>
        <SectionHeading level={3}>Recent Jobs</SectionHeading>
        {loading && jobs.length === 0 ? (
          <QueryState what="recent discovery jobs" loading />
        ) : error && jobs.length === 0 ? (
          <QueryState what="recent discovery jobs" error={new Error(error)} onRetry={loadJobs} />
        ) : (
          <DataTable
            rows={jobs}
            columns={columns}
            rowKey={(job) => job.id}
            emptyLabel="No recent jobs"
            caption="Recent discovery jobs"
            onRowClick={(job) => navigate('/discovery?tab=jobs&jobId=' + job.id)}
          />
        )}
      </div>
    </div>
  );
};

export default DiscoveryDashboard;
