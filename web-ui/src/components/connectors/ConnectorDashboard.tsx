import React, { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { allRunsQuery, connectorsApi, formatRunCount, formatRunTimestamp, runStatusDisplay } from '../../api/connectors';
import { useNavigate } from 'react-router-dom';
import { LiquidGlass } from '../ui/liquid-glass';
import { Badge } from '../ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';

/** The dashboard shows only the newest few runs; the jobs tab holds the full history. */
const RECENT_RUN_LIMIT = 5;

export const ConnectorDashboard: React.FC = () => {
  const navigate = useNavigate();
  const { data: connectors = [], refetch } = useQuery({
    queryKey: ['connectors'],
    queryFn: connectorsApi.list,
  });
  const runsQuery = useQuery(allRunsQuery());
  const runs = runsQuery.data?.runs ?? [];
  const recentRuns = runs.slice(0, RECENT_RUN_LIMIT);
  const totalRuns = runsQuery.data?.total ?? runs.length;

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Configuration-only stats (not derived from runs)
  const totalConnectors = connectors.length;
  const activeConnectors = connectors.filter((c) => c.status === 'active').length;
  const errorConnectors = connectors.filter((c) => c.status === 'error').length;
  const enabledShare = totalConnectors > 0 ? (activeConnectors / totalConnectors) * 100 : 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold mb-2">Connector Dashboard</h2>
        <p className="text-sm text-muted-foreground">
          Monitor and manage ITSM and monitoring platform integrations
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
        <LiquidGlass size="sm" rounded="xl">
          <div className="p-6">
            <p className="text-sm text-muted-foreground mb-2">Total Connectors</p>
            <p className="text-3xl font-bold">{totalConnectors}</p>
          </div>
        </LiquidGlass>
        <LiquidGlass size="sm" rounded="xl">
          <div className="p-6">
            <p className="text-sm text-muted-foreground mb-2">Active</p>
            <p className="text-3xl font-bold text-success">{activeConnectors}</p>
          </div>
        </LiquidGlass>
        <LiquidGlass size="sm" rounded="xl">
          <div className="p-6">
            <p className="text-sm text-muted-foreground mb-2">Enabled Configurations</p>
            <p className="text-3xl font-bold text-success">
              {enabledShare.toFixed(1)}%
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Share of configurations enabled; not a run success rate
            </p>
          </div>
        </LiquidGlass>
        <LiquidGlass size="sm" rounded="xl">
          <div className="p-6">
            <p className="text-sm text-muted-foreground mb-2">Errors</p>
            <p className="text-3xl font-bold text-danger">{errorConnectors}</p>
          </div>
        </LiquidGlass>
      </div>

      {/* Deployed Connectors */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Deployed Connectors</h3>
        {connectors.length === 0 ? (
          <LiquidGlass size="sm" rounded="xl">
            <div className="p-8 text-center">
              <p className="text-muted-foreground">
                No connectors deployed yet. Deploy your first connector to get started.
              </p>
              <button
                onClick={() => navigate('/connectors?tab=definitions')}
                className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
              >
                Deploy Connector
              </button>
            </div>
          </LiquidGlass>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {connectors.map((connector) => {
              const icon = connector.type === 'servicenow' ? '🔷' : connector.type === 'jira' ? '📘' :
                          connector.type === 'datadog' ? '🐕' : connector.type === 'splunk' ? '🔍' :
                          connector.type === 'bmc_remedy' ? '🔶' : '⚙️';
              const statusColor = connector.status === 'active' ? 'text-success' :
                                connector.status === 'error' ? 'text-danger' : 'text-ink-soft';
              return (
                <LiquidGlass
                  key={connector.id}
                  size="sm"
                  rounded="xl"
                  className="cursor-pointer hover:shadow-lg transition-shadow"
                  onClick={() => navigate('/connectors?tab=definitions')}
                >
                  <div className="p-4">
                    <div className="flex items-start justify-between mb-3">
                      <span className="text-3xl">{icon}</span>
                      <Badge variant={connector.status === 'active' ? 'default' : connector.status === 'error' ? 'destructive' : 'secondary'}>
                        {connector.status}
                      </Badge>
                    </div>
                    <div>
                      <h4 className="font-semibold text-foreground mb-1">{connector.name}</h4>
                      <p className="text-xs text-muted-foreground capitalize mb-2">
                        {connector.type.replace('_', ' ')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Updated: {new Date(connector.updated_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                </LiquidGlass>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent Connector Runs: real rows from GET /connector-configs/runs/all */}
      <div>
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-lg font-semibold">Recent Connector Runs</h3>
          {!runsQuery.isError && totalRuns > recentRuns.length && (
            <div className="flex items-center gap-3">
              <p role="status" className="text-sm text-muted-foreground">
                Showing newest {recentRuns.length} of {totalRuns} runs
              </p>
              <button
                onClick={() => navigate('/connectors?tab=jobs')}
                className="text-sm text-primary hover:underline"
              >
                View all runs
              </button>
            </div>
          )}
        </div>
        <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run ID</TableHead>
                <TableHead>Connector</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Records Loaded</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runsQuery.isPending ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center">
                    <p className="text-sm text-muted-foreground py-4">Loading connector runs…</p>
                  </TableCell>
                </TableRow>
              ) : runsQuery.isError ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center">
                    <p className="text-sm text-danger py-4">Failed to load connector runs</p>
                  </TableCell>
                </TableRow>
              ) : runs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center">
                    <p className="text-sm text-muted-foreground py-4">No connector runs recorded</p>
                  </TableCell>
                </TableRow>
              ) : (
                recentRuns.map((run) => {
                  const status = runStatusDisplay(run.status);
                  return (
                    <TableRow
                      key={run.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => navigate('/connectors?tab=jobs&jobId=' + encodeURIComponent(run.id))}
                    >
                      <TableCell>
                        <span className="font-mono text-sm break-all">{run.id}</span>
                      </TableCell>
                      <TableCell>
                        <span className="font-medium">{run.configName}</span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{run.connectorType.toUpperCase()}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </TableCell>
                      <TableCell className="text-right">{formatRunCount(run.recordsLoaded)}</TableCell>
                      <TableCell>{formatRunTimestamp(run.startedAt)}</TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </LiquidGlass>
      </div>
    </div>
  );
};

export default ConnectorDashboard;
