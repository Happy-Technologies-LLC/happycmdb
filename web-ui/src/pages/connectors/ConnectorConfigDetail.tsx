// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Icon } from '@happy-technologies/design-system';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import DataTable from '@/components/common/DataTable';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import {
  connectorService,
  ConnectorConfiguration,
  ConnectorRun,
} from '@/services/connector.service';
import { useToast } from '@/contexts/ToastContext';
import { formatDistanceToNow, format } from 'date-fns';
import type { DataTableColumn } from '@/types';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

export default function ConnectorConfigDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [config, setConfig] = useState<ConnectorConfiguration | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (id) {
      loadConfig();
    }
  }, [id]);

  const loadConfig = async () => {
    if (!id) return;

    try {
      setLoading(true);
      const data = await connectorService.getConnectorConfiguration(id);
      setConfig(data);
    } catch (error: any) {
      showToast(error.message || 'Failed to load connector configuration', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleRunNow = async () => {
    if (!id) return;

    try {
      setRunning(true);
      const run = await connectorService.runConnector(id);
      showToast(`${config?.name} is now running`, 'success');
      await loadConfig();
    } catch (error: any) {
      showToast(error.message || 'Failed to run connector', 'error');
    } finally {
      setRunning(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!id || !config) return;

    try {
      if (config.enabled) {
        await connectorService.disableConnectorConfiguration(id);
        showToast(`${config.name} has been disabled`, 'success');
      } else {
        await connectorService.enableConnectorConfiguration(id);
        showToast(`${config.name} has been enabled`, 'success');
      }
      await loadConfig();
    } catch (error: any) {
      showToast(error.message || 'Failed to update configuration', 'error');
    }
  };

  const handleDelete = async () => {
    if (!id) return;

    try {
      setDeleting(true);
      const result = await connectorService.deleteConnectorConfiguration(id);
      if (result.success) {
        showToast('Connector configuration deleted successfully', 'success');
        navigate('/connectors/installed');
      } else {
        showToast(result.message || 'Failed to delete configuration', 'error');
      }
    } catch (error: any) {
      showToast(error.message || 'Failed to delete configuration', 'error');
    } finally {
      setDeleting(false);
      setShowDeleteDialog(false);
    }
  };

  const getStatusBadge = (status: ConnectorRun['status']) => {
    const variants: Record<ConnectorRun['status'], { variant: any; icon: any }> = {
      COMPLETED: { variant: 'success', icon: 'check-circle' },
      FAILED: { variant: 'destructive', icon: 'x-circle' },
      RUNNING: { variant: 'default', icon: 'clock' },
      QUEUED: { variant: 'outline', icon: 'clock' },
      CANCELLED: { variant: 'outline', icon: 'x-circle' },
    };

    const { variant, icon: iconName } = variants[status] || variants.QUEUED;

    return (
      <Badge variant={variant} className="flex items-center gap-1">
        <Icon name={iconName} size={12} />
        {status}
      </Badge>
    );
  };

  const runColumns: DataTableColumn<ConnectorRun>[] = [
    {
      field: 'startedAt',
      headerName: 'Started',
      flex: 1,
      renderCell: (value: unknown) => (
        <div>
          <div className="text-sm">{format(new Date(value as string | number | Date), 'MMM d, HH:mm')}</div>
          <div className="text-xs text-muted-foreground">
            {formatDistanceToNow(new Date(value as string | number | Date), { addSuffix: true })}
          </div>
        </div>
      ),
    },
    {
      field: 'status',
      headerName: 'Status',
      flex: 1,
      renderCell: (value) => getStatusBadge(value as ConnectorRun['status']),
    },
    {
      field: 'resourceId',
      headerName: 'Resource',
      flex: 1,
      renderCell: (value: unknown) => (value as React.ReactNode) || <span className="text-muted-foreground">All</span>,
    },
    {
      field: 'recordsExtracted',
      headerName: 'Records',
      flex: 1,
      renderCell: (value: unknown, row: ConnectorRun) => (
        <div className="text-sm">
          <div>{value as React.ReactNode} extracted</div>
          <div className="text-xs text-muted-foreground">{row.recordsLoaded} loaded</div>
        </div>
      ),
    },
    {
      field: 'durationMs',
      headerName: 'Duration',
      flex: 1,
      renderCell: (value: unknown) =>
        value ? `${((value as number) / 1000).toFixed(1)}s` : <span className="text-muted-foreground">-</span>,
    },
    {
      field: 'triggeredBy',
      headerName: 'Triggered By',
      flex: 1,
      renderCell: (value: unknown, row: ConnectorRun) => (
        <div className="text-sm">
          <div className="capitalize">{value as React.ReactNode}</div>
          {row.triggeredByUser && (
            <div className="text-xs text-muted-foreground">{row.triggeredByUser}</div>
          )}
        </div>
      ),
    },
  ];

  if (loading || !config) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <LoadingSpinner />
      </div>
    );
  }

  const successRate = config.metrics?.successRate || 0;
  const chartData = config.runs
    ?.slice(0, 10)
    .reverse()
    .map((run) => ({
      name: format(new Date(run.startedAt as string | number | Date), 'MMM d HH:mm'),
      records: run.recordsLoaded,
      duration: run.durationMs ? (run.durationMs as number) / 1000 : 0,
    }));

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <Icon name="arrow-left" size={20} />
        </Button>
        <div className="flex-1">
          <h1 className="text-3xl font-bold">{config.name}</h1>
          {config.description && (
            <p className="text-muted-foreground">{config.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleRunNow} disabled={running || !config.enabled}>
            <Icon name="play-circle" size={16} className="mr-2" />
            {running ? 'Running...' : 'Run Now'}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon">
                <Icon name="dots-three-vertical" size={16} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => navigate(`/connectors/configs/${id}/edit`)}>
                <Icon name="pencil-simple" size={16} className="mr-2" />
                Edit Configuration
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleToggleEnabled}>
                {config.enabled ? 'Disable' : 'Enable'}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setShowDeleteDialog(true)}
                className="text-destructive"
              >
                <Icon name="trash" size={16} className="mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-muted-foreground mb-1">Status</div>
              <Badge variant={config.enabled ? 'success' : 'outline'}>
                {config.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
          </div>
        </Card>

        <Card className="p-4">
          <div className="text-sm text-muted-foreground mb-1">Schedule</div>
          <div className="text-sm">
            {config.scheduleEnabled && config.schedule ? (
              <div>
                <div className="font-medium">{config.schedule}</div>
                <div className="text-xs text-muted-foreground">Active</div>
              </div>
            ) : (
              <span className="text-muted-foreground">Manual only</span>
            )}
          </div>
        </Card>

        <Card className="p-4">
          <div className="text-sm text-muted-foreground mb-1">Success Rate</div>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-bold">{successRate.toFixed(0)}%</div>
            {successRate >= 90 && <Icon name="trend-up" size={16} className="text-green-500" />}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {config.metrics?.successfulRuns || 0} of {config.metrics?.totalRuns || 0} runs
          </div>
        </Card>

        <Card className="p-4">
          <div className="text-sm text-muted-foreground mb-1">Last Run</div>
          <div className="text-sm">
            {config.runs?.[0] ? (
              <div>
                <div className="font-medium">
                  {formatDistanceToNow(new Date(config.runs[0].startedAt as string | number | Date), {
                    addSuffix: true,
                  })}
                </div>
                {getStatusBadge(config.runs[0].status)}
              </div>
            ) : (
              <span className="text-muted-foreground">Never</span>
            )}
          </div>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="resources">Resources</TabsTrigger>
          <TabsTrigger value="runs">Run History</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          <Card className="p-6">
            <h3 className="text-lg font-semibold mb-4">Configuration Details</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-sm text-muted-foreground mb-1">Connector Type</div>
                <div className="text-sm font-medium">{config.connector.name}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Version</div>
                <div className="text-sm font-medium">
                  v{config.connector.installedVersion}
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Max Retries</div>
                <div className="text-sm font-medium">{config.maxRetries}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Retry Delay</div>
                <div className="text-sm font-medium">{config.retryDelaySeconds}s</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Created</div>
                <div className="text-sm font-medium">
                  {format(new Date(config.createdAt as string | number | Date), 'MMM d, yyyy')}
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Updated</div>
                <div className="text-sm font-medium">
                  {format(new Date(config.updatedAt as string | number | Date), 'MMM d, yyyy')}
                </div>
              </div>
            </div>
          </Card>

          <Card className="p-6">
            <h3 className="text-lg font-semibold mb-4">Notifications</h3>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm">On Success</span>
                <Badge variant={config.notificationOnSuccess ? 'success' : 'outline'}>
                  {config.notificationOnSuccess ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">On Failure</span>
                <Badge variant={config.notificationOnFailure ? 'success' : 'outline'}>
                  {config.notificationOnFailure ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
              {config.notificationChannels.length > 0 && (
                <div className="flex items-center gap-2 pt-2">
                  <span className="text-sm text-muted-foreground">Channels:</span>
                  {config.notificationChannels.map((channel) => (
                    <Badge key={channel} variant="outline">
                      {channel}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </TabsContent>

        {/* Resources Tab */}
        <TabsContent value="resources">
          <Card className="p-6">
            <h3 className="text-lg font-semibold mb-4">Enabled Resources</h3>
            {config.enabledResources && config.enabledResources.length > 0 ? (
              <div className="space-y-3">
                {config.enabledResources.map((resourceId) => {
                  const resource = config.connector.resources.find((r) => r.id === resourceId);
                  if (!resource) return null;

                  return (
                    <div key={resourceId} className="p-4 rounded-md border">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium">{resource.name}</span>
                            {resource.ciType && (
                              <Badge variant="secondary">{resource.ciType}</Badge>
                            )}
                          </div>
                          {resource.description && (
                            <p className="text-sm text-muted-foreground mb-2">
                              {resource.description}
                            </p>
                          )}
                          {resource.operations.length > 0 && (
                            <div className="flex gap-1 flex-wrap">
                              {resource.operations.map((op) => (
                                <Badge key={op} variant="outline" className="text-xs">
                                  {op}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No resources enabled. Using connector defaults.
              </p>
            )}
          </Card>
        </TabsContent>

        {/* Run History Tab */}
        <TabsContent value="runs">
          <DataTable
            columns={runColumns}
            data={config.runs || []}
            emptyMessage="No runs yet"
            rowIdField="id"
          />
        </TabsContent>

        {/* Metrics Tab */}
        <TabsContent value="metrics" className="space-y-4">
          {chartData && chartData.length > 0 && (
            <Card className="p-6">
              <h3 className="text-lg font-semibold mb-4">Performance Trends</h3>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis yAxisId="left" />
                  <YAxis yAxisId="right" orientation="right" />
                  <Tooltip />
                  <Legend />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="records"
                    stroke="#8884d8"
                    name="Records Loaded"
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="duration"
                    stroke="#82ca9d"
                    name="Duration (s)"
                  />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          )}

          {config.metrics?.resourceMetrics && config.metrics.resourceMetrics.length > 0 && (
            <Card className="p-6">
              <h3 className="text-lg font-semibold mb-4">Resource Metrics</h3>
              <div className="space-y-4">
                {config.metrics.resourceMetrics.map((metric) => (
                  <div key={metric.resourceId} className="p-4 rounded-md border">
                    <h4 className="font-medium mb-3">{metric.resourceId}</h4>
                    <div className="grid grid-cols-3 gap-4">
                      <div>
                        <div className="text-sm text-muted-foreground">Records Extracted</div>
                        <div className="text-xl font-bold">
                          {metric.totalRecordsExtracted.toLocaleString()}
                        </div>
                      </div>
                      <div>
                        <div className="text-sm text-muted-foreground">Success Rate</div>
                        <div className="text-xl font-bold">{metric.successRate.toFixed(1)}%</div>
                      </div>
                      <div>
                        <div className="text-sm text-muted-foreground">Avg Duration</div>
                        <div className="text-xl font-bold">
                          {(
                            (metric.avgExtractionTimeMs + metric.avgTransformationTimeMs + metric.avgLoadTimeMs) /
                            1000
                          ).toFixed(1)}
                          s
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* Delete Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Configuration</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this connector configuration? This action cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
