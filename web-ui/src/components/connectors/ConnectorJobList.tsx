// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  allRunsQuery,
  connectorsApi,
  formatRunCount,
  formatRunDuration,
  formatRunTimestamp,
  RUN_STATUSES,
  runStatusDisplay,
  UNKNOWN_VALUE,
} from '../../api/connectors';
import { LiquidGlass } from '../ui/liquid-glass';
import { Badge } from '../ui/badge';
import { Icon } from '@happy-technologies/design-system';

const COLUMN_COUNT = 7;

export const ConnectorJobList: React.FC = () => {
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');

  // Run rows come only from GET /connector-configs/runs/all, independent of configurations.
  // The server applies the filters, so these are exactly the newest rows matching them.
  const runsQuery = useQuery(allRunsQuery({
    status: filterStatus === 'all' ? undefined : filterStatus,
    connectorType: filterType === 'all' ? undefined : filterType,
  }));
  const filteredRuns = runsQuery.data?.runs ?? [];
  const total = runsQuery.data?.total ?? null;
  const filtered = filterType !== 'all' || filterStatus !== 'all';

  // Type choices come from the tenant's configurations, not one page of runs; a selected value
  // stays listed so the control never hides an active filter. Statuses are the server's filter enum.
  const configsQuery = useQuery({ queryKey: ['connectors'], queryFn: connectorsApi.list });
  const connectorTypes = [
    ...new Set([...(configsQuery.data ?? []).map((config) => config.type), ...(filterType === 'all' ? [] : [filterType])]),
  ].sort();
  const statuses = RUN_STATUSES;

  const handleRowClick = (jobId: string) => {
    setExpandedJobId(expandedJobId === jobId ? null : jobId);
  };

  const messageRow = (text: string, className: string) => (
    <tr>
      <td colSpan={COLUMN_COUNT} className={`px-4 py-8 text-center text-sm ${className}`}>
        {text}
      </td>
    </tr>
  );

  return (
    <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
      {/* Filters */}
      <div className="p-4 flex flex-wrap gap-3 items-center border-b border-border/50">
        <div className="relative min-w-[150px]">
          <Icon name="funnel" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <select
            aria-label="Filter by connector type"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="w-full pl-10 pr-8 py-2 border border-input rounded-md text-sm appearance-none bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All Connector Types</option>
            {connectorTypes.map((type) => (
              <option key={type} value={type}>
                {type.replace('_', ' ').toUpperCase()}
              </option>
            ))}
          </select>
        </div>

        <select
          aria-label="Filter by status"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="min-w-[150px] px-3 py-2 border border-input rounded-md text-sm appearance-none bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All Statuses</option>
          {statuses.map((status) => (
            <option key={status} value={status}>
              {runStatusDisplay(status).label}
            </option>
          ))}
        </select>

        {!runsQuery.isError && total !== null && total > filteredRuns.length && (
          <p role="status" className="text-sm text-muted-foreground">
            Showing newest {filteredRuns.length} of {total} {filtered ? 'matching ' : ''}runs
          </p>
        )}
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-muted/30 border-b border-border/50">
            <tr>
              <th className="px-4 py-3 text-left w-[50px]"></th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Run ID</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Connector</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Records Loaded</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Started</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {runsQuery.isPending ? (
              messageRow('Loading connector runs…', 'text-muted-foreground')
            ) : runsQuery.isError ? (
              messageRow('Failed to load connector runs', 'text-danger')
            ) : filteredRuns.length === 0 && !filtered ? (
              messageRow('No connector runs recorded', 'text-muted-foreground')
            ) : filteredRuns.length === 0 ? (
              messageRow('No runs match the selected filters', 'text-muted-foreground')
            ) : (
              filteredRuns.map((run) => {
                const status = runStatusDisplay(run.status);
                return (
                  <React.Fragment key={run.id}>
                    <tr
                      className="hover:bg-muted/50 cursor-pointer transition-colors"
                      onClick={() => handleRowClick(run.id)}
                    >
                      <td className="px-4 py-3">
                        <Icon
                          name="caret-down"
                          size={16}
                          className={`text-muted-foreground transition-transform ${
                            expandedJobId === run.id ? 'rotate-180' : ''
                          }`}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-mono text-sm text-foreground break-all">{run.id}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm font-medium text-foreground">{run.configName}</span>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="capitalize">{run.connectorType.replace('_', ' ')}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm font-medium text-foreground">{formatRunCount(run.recordsLoaded)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-sm text-muted-foreground">{formatRunTimestamp(run.startedAt)}</span>
                      </td>
                    </tr>
                    {expandedJobId === run.id && (
                      <tr className="animate-in fade-in-0 slide-in-from-top-2 duration-200">
                        <td colSpan={COLUMN_COUNT} className="p-0 bg-muted/30">
                          <div data-testid="run-detail" className="p-6 grid grid-cols-1 md:grid-cols-4 gap-4">
                            {([
                              ['Records Extracted', formatRunCount(run.recordsExtracted)],
                              ['Records Transformed', formatRunCount(run.recordsTransformed)],
                              ['Records Loaded', formatRunCount(run.recordsLoaded)],
                              ['Records Failed', formatRunCount(run.recordsFailed)],
                              ['Duration', formatRunDuration(run.durationMs)],
                              ['Completed', formatRunTimestamp(run.completedAt)],
                              ['Triggered By', run.triggeredBy ?? UNKNOWN_VALUE],
                              ['Resource', run.resourceId ?? UNKNOWN_VALUE],
                            ] as const).map(([label, value]) => (
                              <div key={label}>
                                <p className="text-xs text-muted-foreground mb-1">{label}</p>
                                <p className="text-lg font-semibold break-all">{value}</p>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </LiquidGlass>
  );
};

export default ConnectorJobList;
