import React, { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { connectorsApi } from '../../api/connectors';
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

type ConnectorStatus = 'active' | 'inactive' | 'error';

const STATUS_CONFIG: Record<ConnectorStatus, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; label: string }> = {
  active: { variant: 'default', label: 'Active' },
  inactive: { variant: 'outline', label: 'Inactive' },
  error: { variant: 'destructive', label: 'Error' },
};

export const ConnectorDashboard: React.FC = () => {
  const navigate = useNavigate();
  const { data: connectors = [], refetch } = useQuery({
    queryKey: ['connectors'],
    queryFn: connectorsApi.list,
  });

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Calculate stats
  const totalConnectors = connectors.length;
  const activeConnectors = connectors.filter((c) => c.status === 'active').length;
  const errorConnectors = connectors.filter((c) => c.status === 'error').length;
  const successRate = totalConnectors > 0 ? (activeConnectors / totalConnectors) * 100 : 0;

  // Get recent sync jobs (mock data for now - replace with real data when available)
  const recentJobs = connectors.slice(0, 5).map((connector) => ({
    id: `job-${connector.id}`,
    connector_name: connector.name,
    connector_type: connector.type,
    status: connector.status as ConnectorStatus,
    records_synced: Math.floor(Math.random() * 1000),
    created_at: connector.last_run_at || connector.created_at || new Date().toISOString(),
  }));

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
            <p className="text-sm text-muted-foreground mb-2">Success Rate</p>
            <p className="text-3xl font-bold text-success">
              {successRate.toFixed(1)}%
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
                      {connector.last_run_at && (
                        <p className="text-xs text-muted-foreground">
                          Last run: {new Date(connector.last_run_at).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  </div>
                </LiquidGlass>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent Sync Jobs */}
      <div>
        <h3 className="text-lg font-semibold mb-4">Recent Sync Jobs</h3>
        <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job ID</TableHead>
                <TableHead>Connector</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Records Synced</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!recentJobs || recentJobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center">
                    <p className="text-sm text-muted-foreground py-4">
                      No recent jobs
                    </p>
                  </TableCell>
                </TableRow>
              ) : (
                recentJobs.map((job) => (
                  <TableRow
                    key={job.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => navigate('/connectors?tab=jobs&jobId=' + job.id)}
                  >
                    <TableCell>
                      <span className="font-mono text-sm">
                        {job.id}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="font-medium">{job.connector_name}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {job.connector_type.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_CONFIG[job.status].variant}>
                        {STATUS_CONFIG[job.status].label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{job.records_synced}</TableCell>
                    <TableCell>
                      {new Date(job.created_at).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </LiquidGlass>
      </div>
    </div>
  );
};

export default ConnectorDashboard;
