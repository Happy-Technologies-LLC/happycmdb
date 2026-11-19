// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  FieldList,
  Icon,
  NativeSelect,
  type Column,
} from '@happy-technologies/design-system';
import {
  allRunsQuery,
  connectorsApi,
  formatRunCount,
  formatRunDuration,
  formatRunTimestamp,
  RUN_STATUSES,
  runStatusDisplay,
  UNKNOWN_VALUE,
  type ConnectorRun,
} from '../../api/connectors';
import { QueryState } from '@/components/estate/SurfaceState';
import { classifyError } from '@/lib/estate';

/** The DS tone for each of `runStatusDisplay`'s variants; the status text always travels with it. */
const RUN_BADGE_TONE = { default: 'info', secondary: 'success', destructive: 'danger', outline: 'neutral' } as const;

/** A run's status as a DS badge: a tone plus the text label, never colour alone. */
export const RunStatusBadge: React.FC<{ status: string }> = ({ status }) => {
  const { variant, label } = runStatusDisplay(status);
  return (
    <Badge variant={RUN_BADGE_TONE[variant]} dot>
      {label}
    </Badge>
  );
};

/** A refused run read names the refusal (the shell shows the server's reason); any other failure is fixed text, never the server message. */
export const RunsReadFailure: React.FC<{ error: unknown; onRetry: () => void }> = ({ error, onRetry }) =>
  classifyError(error).kind === 'forbidden' ? (
    <QueryState what="connector runs" error={error} />
  ) : (
    <EmptyState
      tone="danger"
      icon="warning-circle"
      title="Failed to load connector runs"
      action={
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );

export const ConnectorJobList: React.FC = () => {
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

  const columns: Array<Column<ConnectorRun>> = [
    { header: 'Run ID', render: (run) => <span className="font-mono text-sm break-all">{run.id}</span> },
    { header: 'Connector', render: (run) => <span className="text-sm font-medium">{run.configName}</span> },
    {
      header: 'Type',
      render: (run) => (
        <Badge variant="neutral" className="capitalize">
          {run.connectorType.replace('_', ' ')}
        </Badge>
      ),
    },
    { header: 'Status', render: (run) => <RunStatusBadge status={run.status} /> },
    { header: 'Records Loaded', render: (run) => <span className="text-sm font-medium">{formatRunCount(run.recordsLoaded)}</span> },
    { header: 'Started', render: (run) => <span className="text-sm">{formatRunTimestamp(run.startedAt)}</span> },
  ];

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[190px]">
          <Icon
            name="funnel"
            size={16}
            className="pointer-events-none absolute top-1/2 left-3 z-10 -translate-y-1/2 text-[var(--hh-text-muted)]"
          />
          <NativeSelect
            aria-label="Filter by connector type"
            size="sm"
            className="pl-9"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
          >
            <option value="all">All Connector Types</option>
            {connectorTypes.map((type) => (
              <option key={type} value={type}>
                {type.replace('_', ' ').toUpperCase()}
              </option>
            ))}
          </NativeSelect>
        </div>

        <NativeSelect
          aria-label="Filter by status"
          size="sm"
          containerClassName="min-w-[170px]"
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        >
          <option value="all">All Statuses</option>
          {statuses.map((status) => (
            <option key={status} value={status}>
              {runStatusDisplay(status).label}
            </option>
          ))}
        </NativeSelect>

        {!runsQuery.isError && total !== null && total > filteredRuns.length && (
          <p role="status" className="text-sm text-[var(--hh-text-muted)]">
            Showing newest {filteredRuns.length} of {total} {filtered ? 'matching ' : ''}runs
          </p>
        )}
      </div>

      {runsQuery.isPending ? (
        <Card>
          <EmptyState loading label="Loading connector runs…" />
        </Card>
      ) : runsQuery.isError ? (
        <Card>
          <RunsReadFailure error={runsQuery.error} onRetry={() => void runsQuery.refetch()} />
        </Card>
      ) : (
        <DataTable
          caption="Connector runs"
          rows={filteredRuns}
          columns={columns}
          rowKey={(run) => run.id}
          emptyLabel={filtered ? 'No runs match the selected filters' : 'No connector runs recorded'}
          renderExpanded={(run) => (
            <div data-testid="run-detail">
              <FieldList
                fields={[
                  ['Records Extracted', formatRunCount(run.recordsExtracted)],
                  ['Records Transformed', formatRunCount(run.recordsTransformed)],
                  ['Records Loaded', formatRunCount(run.recordsLoaded)],
                  ['Records Failed', formatRunCount(run.recordsFailed)],
                  ['Duration', formatRunDuration(run.durationMs)],
                  ['Completed', formatRunTimestamp(run.completedAt)],
                  ['Triggered By', run.triggeredBy ?? UNKNOWN_VALUE],
                  ['Resource', run.resourceId ?? UNKNOWN_VALUE],
                ]}
              />
            </div>
          )}
        />
      )}
    </div>
  );
};

export default ConnectorJobList;
