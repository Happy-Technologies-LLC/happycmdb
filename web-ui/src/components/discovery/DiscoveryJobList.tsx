// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { DiscoveryJob, DiscoveryProvider, JobStatus } from '../../services/discovery.service';
import { useDiscoveryJobs } from '../../hooks/useDiscoveryJobs';
import DiscoveryJobStatus from './DiscoveryJobStatus';
import { useDiscovery } from '../../hooks/useDiscovery';
import { LiquidGlass } from '../ui/liquid-glass';
import { Badge } from '../ui/badge';
import { Search, Filter, ChevronDown, RefreshCw, X } from 'lucide-react';

const STATUS_CONFIG: Record<JobStatus, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  pending: { variant: 'outline', label: 'Pending' },
  running: { variant: 'default', label: 'Running' },
  completed: { variant: 'secondary', label: 'Completed' },
  failed: { variant: 'destructive', label: 'Failed' },
  cancelled: { variant: 'outline', label: 'Cancelled' },
};

const PROVIDERS: DiscoveryProvider[] = ['nmap', 'ssh', 'active-directory', 'snmp'];
const STATUSES: JobStatus[] = ['pending', 'running', 'completed', 'failed', 'cancelled'];

export const DiscoveryJobList: React.FC = () => {
  const {
    jobs,
    total,
    page,
    totalPages,
    loading,
    setFilters,
    setPage,
    filters,
  } = useDiscoveryJobs({}, true);

  const { retryJob, cancelJob } = useDiscovery();
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [showDefinitionFilter, setShowDefinitionFilter] = useState(false);

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

  const handleRowClick = (jobId: string) => {
    setExpandedJobId(expandedJobId === jobId ? null : jobId);
  };

  // Get unique definition names from jobs for filter
  const uniqueDefinitions = Array.from(
    new Map(
      jobs
        .filter((job) => job.definitionId && job.definitionName)
        .map((job) => [job.definitionId, job.definitionName])
    ).entries()
  ).map(([id, name]) => ({ id, name }));

  const formatLabel = (value: string) => {
    return value
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  return (
    <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
      {/* Filters */}
      <div className="p-4 flex flex-wrap gap-3 items-center border-b border-border/50">
        <div className="relative min-w-[150px]">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <select
            value={filters.provider || 'all'}
            onChange={(e) => handleProviderChange(e.target.value === 'all' ? [] : [e.target.value])}
            className="w-full pl-10 pr-8 py-2 border border-input rounded-md text-sm appearance-none bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All Providers</option>
            {PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {provider.toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        <select
          value={filters.status || 'all'}
          onChange={(e) => handleStatusChange(e.target.value === 'all' ? [] : [e.target.value])}
          className="min-w-[150px] px-3 py-2 border border-input rounded-md text-sm appearance-none bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All Statuses</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_CONFIG[status].label}
            </option>
          ))}
        </select>

        {uniqueDefinitions.length > 0 && (
          <select
            value={filters.definitionId || 'all'}
            onChange={(e) => handleDefinitionFilterChange(e.target.value)}
            className="min-w-[200px] px-3 py-2 border border-input rounded-md text-sm appearance-none bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All Definitions</option>
            {uniqueDefinitions.map((def) => (
              <option key={def.id} value={def.id || ''}>
                {def.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-muted/30 border-b border-border/50">
            <tr>
              <th className="px-4 py-3 text-left w-[50px]"></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Job ID</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Definition</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Provider</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Progress</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">CIs</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {!jobs || jobs.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No jobs found
                </td>
              </tr>
            ) : (
              jobs.map((job) => (
                <React.Fragment key={job.id}>
                  <tr
                    className="hover:bg-muted/50 cursor-pointer transition-colors"
                    onClick={() => handleRowClick(job.id)}
                  >
                    <td className="px-4 py-3">
                      <ChevronDown
                        className={`h-4 w-4 text-muted-foreground transition-transform ${
                          expandedJobId === job.id ? 'rotate-180' : ''
                        }`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-sm text-foreground">
                        {job.id}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {job.definitionName ? (
                        <span className="text-sm font-medium text-foreground">{job.definitionName}</span>
                      ) : (
                        <span className="text-sm text-muted-foreground italic">Ad-hoc</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline">{job.provider.toUpperCase()}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={STATUS_CONFIG[job.status].variant}>
                        {STATUS_CONFIG[job.status].label}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 w-full max-w-[150px]">
                        <div className="flex-1 h-2 bg-line-soft rounded-full overflow-hidden">
                          <div
                            className="h-full bg-sky transition-all"
                            style={{ width: `${job.progress}%` }}
                          />
                        </div>
                        <span className="text-xs text-foreground">{job.progress}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm font-medium text-foreground">{job.discoveredCIs}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-muted-foreground">
                        {new Date(job.createdAt).toLocaleString()}
                      </span>
                    </td>
                  </tr>
                  {expandedJobId === job.id && (
                    <tr className="animate-in fade-in-0 slide-in-from-top-2 duration-200">
                      <td colSpan={8} className="p-0 bg-muted/30">
                        <div className="w-full">
                          <DiscoveryJobStatus
                            job={job}
                            onRetry={retryJob}
                            onCancel={cancelJob}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="px-4 py-3 flex items-center justify-between border-t border-border/50">
          <p className="text-sm text-foreground">
            Page {page} of {totalPages}
          </p>
          <div className="flex gap-1">
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page === 1}
              className="px-3 py-1 border border-input rounded text-sm bg-background text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page === totalPages}
              className="px-3 py-1 border border-input rounded text-sm bg-background text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </LiquidGlass>
  );
};

export default DiscoveryJobList;
