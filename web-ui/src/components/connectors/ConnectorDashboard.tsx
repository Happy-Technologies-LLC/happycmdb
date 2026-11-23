import React, { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  MetricCard,
  SectionHeading,
  Skeleton,
  type Column,
} from '@happy-technologies/design-system';
import {
  allRunsQuery,
  connectorsApi,
  formatRunCount,
  formatRunTimestamp,
  UNKNOWN_VALUE,
  type ConnectorRun,
} from '../../api/connectors';
import { QueryState } from '@/components/estate/SurfaceState';
import { RunStatusBadge, RunsReadFailure } from './ConnectorJobList';

/** The dashboard shows only the newest few runs; the jobs tab holds the full history. */
const RECENT_RUN_LIMIT = 5;

const CONNECTOR_STATUS_TONE = { active: 'success', error: 'danger' } as const;

export const ConnectorDashboard: React.FC = () => {
  const navigate = useNavigate();
  const connectorsQuery = useQuery({
    queryKey: ['connectors'],
    queryFn: connectorsApi.list,
  });
  const { refetch } = connectorsQuery;
  const runsQuery = useQuery(allRunsQuery());
  const runs = runsQuery.data?.runs ?? [];
  const recentRuns = runs.slice(0, RECENT_RUN_LIMIT);
  const totalRuns = runsQuery.data?.total ?? runs.length;

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Configuration-only stats (not derived from runs). A failed or pending read has no connectors:
  // the figures are then unavailable, never a zero.
  const connectors = connectorsQuery.isError ? undefined : connectorsQuery.data;
  const loading = connectorsQuery.isPending;
  const totalConnectors = connectors?.length;
  const activeConnectors = connectors?.filter((c) => c.status === 'active').length;
  const errorConnectors = connectors?.filter((c) => c.status === 'error').length;
  const enabledShare =
    connectors && connectors.length > 0 ? ((activeConnectors ?? 0) / connectors.length) * 100 : undefined;
  const figure = (value: number | undefined) => (value === undefined ? UNKNOWN_VALUE : value);
  const unavailable = connectorsQuery.isError ? 'Unavailable' : undefined;

  const runColumns: Array<Column<ConnectorRun>> = [
    { header: 'Run ID', render: (run) => <span className="font-mono text-sm break-all">{run.id}</span> },
    { header: 'Connector', render: (run) => <span className="font-medium">{run.configName}</span> },
    { header: 'Type', render: (run) => <Badge variant="neutral">{run.connectorType.toUpperCase()}</Badge> },
    { header: 'Status', render: (run) => <RunStatusBadge status={run.status} /> },
    { header: 'Records Loaded', className: 'text-right', render: (run) => formatRunCount(run.recordsLoaded) },
    { header: 'Started', render: (run) => formatRunTimestamp(run.startedAt) },
  ];

  return (
    <div className="space-y-6">
      <div>
        <SectionHeading level={2}>Connector Dashboard</SectionHeading>
        <p className="-mt-2 text-sm text-[var(--hh-text-muted)]">
          Monitor and manage ITSM and monitoring platform integrations
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
        <MetricCard
          icon="plugs-connected"
          tone="accent"
          label="Total Connectors"
          value={figure(totalConnectors)}
          sub={unavailable}
          loading={loading}
        />
        <MetricCard
          icon="check-circle"
          tone="success"
          label="Active"
          value={figure(activeConnectors)}
          sub={unavailable}
          loading={loading}
        />
        <MetricCard
          icon="toggle-right"
          tone="success"
          label="Enabled Configurations"
          value={enabledShare === undefined ? UNKNOWN_VALUE : enabledShare.toFixed(1)}
          unit={enabledShare === undefined ? undefined : '%'}
          sub={unavailable ?? 'Share of configurations enabled; not a run success rate'}
          loading={loading}
        />
        <MetricCard
          icon="warning-circle"
          tone="danger"
          label="Errors"
          value={figure(errorConnectors)}
          sub={unavailable}
          loading={loading}
        />
      </div>

      {/* Deployed Connectors */}
      <div>
        <SectionHeading level={3}>Deployed Connectors</SectionHeading>
        {loading ? (
          <div aria-busy="true" className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        ) : connectorsQuery.isError ? (
          <Card>
            <QueryState what="connectors" error={connectorsQuery.error} onRetry={() => void refetch()} />
          </Card>
        ) : connectors && connectors.length === 0 ? (
          <Card>
            <EmptyState
              icon="plugs"
              title="No connectors deployed yet"
              description="Deploy your first connector to get started."
              action={
                <Button size="sm" onClick={() => navigate('/connectors?tab=definitions')}>
                  Deploy Connector
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {(connectors ?? []).map((connector) => {
              const icon = connector.type === 'servicenow' ? '🔷' : connector.type === 'jira' ? '📘' :
                          connector.type === 'datadog' ? '🐕' : connector.type === 'splunk' ? '🔍' :
                          connector.type === 'bmc_remedy' ? '🔶' : '⚙️';
              const open = () => navigate('/connectors?tab=definitions');
              return (
                <Card
                  key={connector.id}
                  role="link"
                  tabIndex={0}
                  className="cursor-pointer"
                  onClick={open}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      open();
                    }
                  }}
                >
                  <div className="mb-3 flex items-start justify-between">
                    <span aria-hidden="true" className="text-3xl">{icon}</span>
                    <Badge variant={CONNECTOR_STATUS_TONE[connector.status as keyof typeof CONNECTOR_STATUS_TONE] ?? 'neutral'} dot>
                      {connector.status}
                    </Badge>
                  </div>
                  <div>
                    <h4 className="mb-1 font-semibold">{connector.name}</h4>
                    <p className="mb-2 text-xs capitalize text-[var(--hh-text-muted)]">
                      {connector.type.replace('_', ' ')}
                    </p>
                    <p className="text-xs text-[var(--hh-text-muted)]">
                      Updated: {new Date(connector.updated_at).toLocaleDateString()}
                    </p>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent Connector Runs: real rows from GET /connector-configs/runs/all */}
      <div>
        <SectionHeading
          level={3}
          right={
            !runsQuery.isError && totalRuns > recentRuns.length ? (
              <div className="flex items-center gap-3">
                <p role="status" className="text-sm text-[var(--hh-text-muted)]">
                  Showing newest {recentRuns.length} of {totalRuns} runs
                </p>
                <Button size="sm" variant="link" onClick={() => navigate('/connectors?tab=jobs')}>
                  View all runs
                </Button>
              </div>
            ) : undefined
          }
        >
          Recent Connector Runs
        </SectionHeading>
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
            caption="Recent connector runs"
            rows={recentRuns}
            columns={runColumns}
            rowKey={(run) => run.id}
            emptyLabel="No connector runs recorded"
            onRowClick={(run) => navigate('/connectors?tab=jobs&jobId=' + encodeURIComponent(run.id))}
          />
        )}
      </div>
    </div>
  );
};

export default ConnectorDashboard;
