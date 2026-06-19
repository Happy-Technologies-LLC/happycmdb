// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { connectorsApi } from '../../api/connectors';
import { LiquidGlass } from '../ui/liquid-glass';
import { Badge } from '../ui/badge';
import { Search, Filter, ChevronDown } from 'lucide-react';

type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

const STATUS_CONFIG: Record<JobStatus, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  pending: { variant: 'outline', label: 'Pending' },
  running: { variant: 'default', label: 'Running' },
  completed: { variant: 'secondary', label: 'Completed' },
  failed: { variant: 'destructive', label: 'Failed' },
  cancelled: { variant: 'outline', label: 'Cancelled' },
};

const CONNECTOR_TYPES = ['servicenow', 'jira', 'bmc_remedy', 'datadog', 'splunk', 'custom'];
const STATUSES: JobStatus[] = ['pending', 'running', 'completed', 'failed', 'cancelled'];

export const ConnectorJobList: React.FC = () => {
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');

  const { data: connectors = [] } = useQuery({
    queryKey: ['connectors'],
    queryFn: connectorsApi.list,
  });

  // Mock job data for demonstration (replace with real API call when available)
  const jobs = connectors.flatMap((connector) =>
    [1, 2, 3].map((i) => ({
      id: `job-${connector.id}-${i}`,
      connector_id: connector.id,
      connector_name: connector.name,
      connector_type: connector.type,
      status: (['completed', 'running', 'failed'] as JobStatus[])[i % 3],
      progress: i === 2 ? 100 : i === 1 ? 65 : 100,
      records_synced: Math.floor(Math.random() * 1000),
      records_created: Math.floor(Math.random() * 100),
      records_updated: Math.floor(Math.random() * 200),
      records_failed: i === 0 ? Math.floor(Math.random() * 10) : 0,
      created_at: new Date(Date.now() - i * 86400000).toISOString(),
      duration: `${Math.floor(Math.random() * 10) + 1}m ${Math.floor(Math.random() * 60)}s`,
    }))
  );

  const filteredJobs = jobs.filter((job) => {
    if (filterType !== 'all' && job.connector_type !== filterType) {
      return false;
    }
    if (filterStatus !== 'all' && job.status !== filterStatus) {
      return false;
    }
    return true;
  });

  const handleRowClick = (jobId: string) => {
    setExpandedJobId(expandedJobId === jobId ? null : jobId);
  };

  return (
    <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
      {/* Filters */}
      <div className="p-4 flex flex-wrap gap-3 items-center border-b border-border/50">
        <div className="relative min-w-[150px]">
          <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="w-full pl-10 pr-8 py-2 border border-input rounded-md text-sm appearance-none bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All Connector Types</option>
            {CONNECTOR_TYPES.map((type) => (
              <option key={type} value={type}>
                {type.replace('_', ' ').toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="min-w-[150px] px-3 py-2 border border-input rounded-md text-sm appearance-none bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All Statuses</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_CONFIG[status].label}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-muted/30 border-b border-border/50">
            <tr>
              <th className="px-4 py-3 text-left w-[50px]"></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Job ID</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Connector</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Progress</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Records</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {!jobs || jobs.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No sync jobs found
                </td>
              </tr>
            ) : (
              filteredJobs.map((job) => (
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
                        {job.id.substring(0, 12)}...
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm font-medium text-foreground">{job.connector_name}</span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="capitalize">{job.connector_type.replace('_', ' ')}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={STATUS_CONFIG[job.status].variant}>
                        {STATUS_CONFIG[job.status].label}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 w-full max-w-[150px]">
                        <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary transition-all"
                            style={{ width: `${job.progress}%` }}
                          />
                        </div>
                        <span className="text-xs text-foreground">{job.progress}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm font-medium text-foreground">{job.records_synced}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-muted-foreground">
                        {new Date(job.created_at).toLocaleString()}
                      </span>
                    </td>
                  </tr>
                  {expandedJobId === job.id && (
                    <tr className="animate-in fade-in-0 slide-in-from-top-2 duration-200">
                      <td colSpan={8} className="p-0 bg-muted/30">
                        <div className="p-6 space-y-4">
                          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                            <div>
                              <p className="text-xs text-muted-foreground mb-1">Records Created</p>
                              <p className="text-lg font-semibold text-success">{job.records_created}</p>
                            </div>
                            <div>
                              <p className="text-xs text-muted-foreground mb-1">Records Updated</p>
                              <p className="text-lg font-semibold text-sky-text">{job.records_updated}</p>
                            </div>
                            <div>
                              <p className="text-xs text-muted-foreground mb-1">Records Failed</p>
                              <p className="text-lg font-semibold text-danger">{job.records_failed}</p>
                            </div>
                            <div>
                              <p className="text-xs text-muted-foreground mb-1">Duration</p>
                              <p className="text-lg font-semibold">{job.duration}</p>
                            </div>
                          </div>

                          {job.records_failed > 0 && (
                            <div className="bg-danger-soft border border-danger/20 rounded-lg p-3">
                              <p className="text-sm font-semibold text-danger mb-1">Sync Errors</p>
                              <p className="text-xs text-danger">
                                {job.records_failed} records failed to sync. Check logs for details.
                              </p>
                            </div>
                          )}
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
    </LiquidGlass>
  );
};

export default ConnectorJobList;
