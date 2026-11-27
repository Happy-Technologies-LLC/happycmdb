// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  CHART_COLORS,
  Card,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Icon,
  IconButton,
  Menu,
  PageHeader,
  SectionHeading,
  TabPanel,
  Tabs,
} from '@happy-technologies/design-system';
import { QueryState } from '@/components/estate/SurfaceState';
import { RequirePermission } from '@/components/common/RequirePermission';
import {
  connectorService,
  ConnectorConfiguration,
  ConnectorRun,
} from '@/services/connector.service';
import { useToast } from '@/contexts/ToastContext';
import { forbiddenReason } from '@/lib/forbidden';
import { formatDistanceToNow, format } from 'date-fns';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

type TabValue = 'overview' | 'resources' | 'runs' | 'metrics';

const TABS_ID = 'connector-config-tabs';

const TAB_OPTIONS: Array<{ value: TabValue; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'resources', label: 'Resources' },
  { value: 'runs', label: 'Run History' },
  { value: 'metrics', label: 'Metrics' },
];

/**
 * The server's reason when `error` is a refused (403) read, else null. The configuration is read through Apollo, so a
 * refusal arrives as an ApolloError (networkError status 403, or a FORBIDDEN GraphQL error); the axios shape is
 * accepted too.
 */
function refusalReason(error: unknown): string | null {
  const e = error as {
    response?: { status?: number; data?: unknown };
    networkError?: { statusCode?: number; response?: { status?: number }; result?: unknown } | null;
    graphQLErrors?: Array<{ message?: string; extensions?: { code?: unknown } }>;
  } | null;
  if (!e || typeof e !== 'object') return null;
  if (e.response?.status === 403) return forbiddenReason(e.response.data);
  const net = e.networkError;
  if (net && (net.statusCode === 403 || net.response?.status === 403)) return forbiddenReason(net.result);
  const refused = e.graphQLErrors?.find((g) => g?.extensions?.code === 'FORBIDDEN');
  if (refused) return forbiddenReason({ message: refused.message });
  return null;
}

const MUTED = 'text-[var(--hh-text-muted)]';

export default function ConnectorConfigDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [running, setRunning] = useState(false);
  const [config, setConfig] = useState<ConnectorConfiguration | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [tab, setTab] = useState<TabValue>('overview');

  useEffect(() => {
    if (id) {
      loadConfig();
    }
  }, [id]);

  // `keepOnFailure`: a reload after a successful action must not replace the page already on screen with an
  // error (the action itself worked); the stale data stays and a toast says the refresh failed.
  const readConfig = async (keepOnFailure: boolean) => {
    if (!id) return;

    try {
      setLoading(true);
      setError(null);
      const data = await connectorService.getConnectorConfiguration(id);
      setConfig(data);
    } catch (err) {
      if (keepOnFailure) {
        showToast('Failed to refresh connector configuration', 'error');
      } else {
        setConfig(null);
        setError(err ?? new Error('Request failed'));
        if (refusalReason(err) === null) {
          showToast('Failed to load connector configuration', 'error');
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const loadConfig = () => readConfig(false);
  const refreshConfig = () => readConfig(true);

  const handleRunNow = async () => {
    if (!id) return;

    try {
      setRunning(true);
      await connectorService.runConnector(id);
      showToast(`${config?.name} is now running`, 'success');
      await refreshConfig();
    } catch {
      showToast('Failed to run connector', 'error');
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
      await refreshConfig();
    } catch {
      showToast('Failed to update configuration', 'error');
    }
  };

  const handleDelete = async () => {
    if (!id || deleting) return;

    try {
      setDeleting(true);
      const result = await connectorService.deleteConnectorConfiguration(id);
      if (result.success) {
        showToast('Connector configuration deleted successfully', 'success');
        navigate('/connectors/installed');
      } else {
        showToast('Failed to delete configuration', 'error');
      }
    } catch {
      showToast('Failed to delete configuration', 'error');
    } finally {
      setDeleting(false);
      setShowDeleteDialog(false);
    }
  };

  const getStatusBadge = (status: ConnectorRun['status']) => {
    const variants: Record<ConnectorRun['status'], { variant: 'success' | 'danger' | 'info' | 'neutral'; icon: string }> = {
      COMPLETED: { variant: 'success', icon: 'check-circle' },
      FAILED: { variant: 'danger', icon: 'x-circle' },
      RUNNING: { variant: 'info', icon: 'clock' },
      QUEUED: { variant: 'neutral', icon: 'clock' },
      CANCELLED: { variant: 'neutral', icon: 'x-circle' },
    };

    const { variant, icon: iconName } = variants[status] || variants.QUEUED;

    return (
      <Badge variant={variant}>
        <Icon name={iconName} size={12} />
        {status}
      </Badge>
    );
  };

  const runColumns = [
    {
      key: 'startedAt',
      header: 'Started',
      render: (row: ConnectorRun) => (
        <div>
          <div className="text-sm">{format(new Date(row.startedAt as string | number | Date), 'MMM d, HH:mm')}</div>
          <div className={`text-xs ${MUTED}`}>
            {formatDistanceToNow(new Date(row.startedAt as string | number | Date), { addSuffix: true })}
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row: ConnectorRun) => getStatusBadge(row.status),
    },
    {
      key: 'resourceId',
      header: 'Resource',
      render: (row: ConnectorRun) => (row.resourceId as React.ReactNode) || <span className={MUTED}>All</span>,
    },
    {
      key: 'recordsExtracted',
      header: 'Records',
      render: (row: ConnectorRun) => (
        <div className="text-sm">
          <div>{row.recordsExtracted as React.ReactNode} extracted</div>
          <div className={`text-xs ${MUTED}`}>{row.recordsLoaded} loaded</div>
        </div>
      ),
    },
    {
      key: 'durationMs',
      header: 'Duration',
      render: (row: ConnectorRun) =>
        row.durationMs ? `${((row.durationMs as number) / 1000).toFixed(1)}s` : <span className={MUTED}>-</span>,
    },
    {
      key: 'triggeredBy',
      header: 'Triggered By',
      render: (row: ConnectorRun) => <div className="capitalize">{row.triggeredBy as React.ReactNode}</div>,
    },
  ];

  if (loading) {
    return <QueryState what="connector configuration" loading />;
  }

  if (error !== null) {
    const reason = refusalReason(error);
    if (reason !== null) {
      return <EmptyState tone="danger" icon="lock-key" title="Not permitted" description={reason} />;
    }
    return <QueryState what="connector configuration" error={error} onRetry={loadConfig} />;
  }

  if (!config) {
    return (
      <EmptyState
        icon="plugs"
        title="Connector configuration not found"
        action={
          <Button variant="secondary" onClick={() => navigate(-1)}>
            Back
          </Button>
        }
      />
    );
  }

  const metrics = config.metrics;
  const successRate = metrics?.successRate || 0;
  const chartData = config.runs
    ?.slice(0, 10)
    .reverse()
    .map((run) => ({
      name: format(new Date(run.startedAt as string | number | Date), 'MMM d HH:mm'),
      records: run.recordsLoaded,
      duration: run.durationMs ? (run.durationMs as number) / 1000 : 0,
    }));

  const labelClass = `text-sm ${MUTED} mb-1`;

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <IconButton icon="arrow-left" aria-label="Back" variant="ghost" onClick={() => navigate(-1)} />
        <PageHeader
          className="flex-1"
          eyebrow="Connector configuration"
          title={config.name}
          lede={config.description || undefined}
          actions={
            /* Connector config run/edit/enable/delete: requirePermission('write') (GraphQL + REST) */
            <RequirePermission permission="write">
              <Button
                icon="play-circle"
                onClick={handleRunNow}
                disabled={running || !config.enabled}
              >
                {running ? 'Running...' : 'Run Now'}
              </Button>
              <Menu
                align="end"
                trigger={
                  <>
                    <Icon name="dots-three-vertical" size={16} />
                    <span className="sr-only">More actions</span>
                  </>
                }
                items={[
                  {
                    label: 'Edit Configuration',
                    icon: 'pencil-simple',
                    onClick: () => navigate(`/connectors/configs/${id}/edit`),
                  },
                  {
                    label: config.enabled ? 'Disable' : 'Enable',
                    onClick: handleToggleEnabled,
                  },
                  {
                    label: 'Delete',
                    icon: 'trash',
                    danger: true,
                    onClick: () => setShowDeleteDialog(true),
                  },
                ]}
              />
            </RequirePermission>
          }
        />
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <div className={labelClass}>Status</div>
              <Badge variant={config.enabled ? 'success' : 'neutral'}>
                {config.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
          </div>
        </Card>

        <Card>
          <div className={labelClass}>Schedule</div>
          <div className="text-sm">
            {config.scheduleEnabled && config.schedule ? (
              <div>
                <div className="font-medium">{config.schedule}</div>
                <div className={`text-xs ${MUTED}`}>Active</div>
              </div>
            ) : (
              <span className={MUTED}>Manual only</span>
            )}
          </div>
        </Card>

        <Card>
          <div className={labelClass}>Success Rate</div>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-bold">{metrics ? `${successRate.toFixed(0)}%` : '-'}</div>
            {metrics && successRate >= 90 && (
              <Icon name="trend-up" size={16} className="text-[var(--hh-success-text)]" />
            )}
          </div>
          {metrics && (
            <div className={`text-xs ${MUTED} mt-1`}>
              {metrics.successfulRuns || 0} of {metrics.totalRuns || 0} runs
            </div>
          )}
        </Card>

        <Card>
          <div className={labelClass}>Last Run</div>
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
              <span className={MUTED}>Never</span>
            )}
          </div>
        </Card>
      </div>

      {/* Tabs */}
      <div className="space-y-4">
        <Tabs id={TABS_ID} value={tab} onChange={setTab} options={TAB_OPTIONS} />

        {/* Overview Tab */}
        <TabPanel tabsId={TABS_ID} value="overview" selected={tab === 'overview'} className="space-y-4">
          <Card>
            <SectionHeading level={3}>Configuration Details</SectionHeading>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className={labelClass}>Connector Type</div>
                <div className="text-sm font-medium">{config.connector.name}</div>
              </div>
              <div>
                <div className={labelClass}>Version</div>
                <div className="text-sm font-medium">
                  v{config.connector.installedVersion}
                </div>
              </div>
              <div>
                <div className={labelClass}>Max Retries</div>
                <div className="text-sm font-medium">{config.maxRetries}</div>
              </div>
              <div>
                <div className={labelClass}>Retry Delay</div>
                <div className="text-sm font-medium">{config.retryDelaySeconds}s</div>
              </div>
              <div>
                <div className={labelClass}>Created</div>
                <div className="text-sm font-medium">
                  {format(new Date(config.createdAt as string | number | Date), 'MMM d, yyyy')}
                </div>
              </div>
              <div>
                <div className={labelClass}>Updated</div>
                <div className="text-sm font-medium">
                  {format(new Date(config.updatedAt as string | number | Date), 'MMM d, yyyy')}
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <SectionHeading level={3}>Notifications</SectionHeading>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm">On Success</span>
                <Badge variant={config.notificationOnSuccess ? 'success' : 'neutral'}>
                  {config.notificationOnSuccess ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">On Failure</span>
                <Badge variant={config.notificationOnFailure ? 'success' : 'neutral'}>
                  {config.notificationOnFailure ? 'Enabled' : 'Disabled'}
                </Badge>
              </div>
            </div>
          </Card>
        </TabPanel>

        {/* Resources Tab */}
        <TabPanel tabsId={TABS_ID} value="resources" selected={tab === 'resources'}>
          <Card>
            <SectionHeading level={3}>Enabled Resources</SectionHeading>
            {config.enabledResources && config.enabledResources.length > 0 ? (
              <div className="space-y-3">
                {config.enabledResources.map((resourceId) => {
                  const resource = config.connector.resources.find((r) => r.id === resourceId);
                  if (!resource) return null;

                  return (
                    <div key={resourceId} className="p-4 rounded-md border border-[var(--hh-border)]">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium">{resource.name}</span>
                            {resource.ciType && (
                              <Badge variant="neutral">{resource.ciType}</Badge>
                            )}
                          </div>
                          {resource.description && (
                            <p className={`text-sm ${MUTED} mb-2`}>
                              {resource.description}
                            </p>
                          )}
                          {resource.operations.length > 0 && (
                            <div className="flex gap-1 flex-wrap">
                              {resource.operations.map((op) => (
                                <Badge key={op} variant="neutral">
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
              <p className={`text-sm ${MUTED}`}>
                No resources enabled. Using connector defaults.
              </p>
            )}
          </Card>
        </TabPanel>

        {/* Run History Tab */}
        <TabPanel tabsId={TABS_ID} value="runs" selected={tab === 'runs'}>
          <DataTable
            caption="Run history"
            columns={runColumns}
            rows={config.runs || []}
            rowKey={(r) => r.id}
            emptyLabel="No runs yet"
          />
        </TabPanel>

        {/* Metrics Tab */}
        <TabPanel tabsId={TABS_ID} value="metrics" selected={tab === 'metrics'} className="space-y-4">
          {tab === 'metrics' && chartData && chartData.length > 0 && (
            <Card>
              <SectionHeading level={3}>Performance Trends</SectionHeading>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--hh-border)" />
                  <XAxis dataKey="name" />
                  <YAxis yAxisId="left" />
                  <YAxis yAxisId="right" orientation="right" />
                  <Tooltip />
                  <Legend />
                  <Line
                    yAxisId="left"
                    type="monotone"
                    dataKey="records"
                    stroke={CHART_COLORS[0]}
                    name="Records Loaded"
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="duration"
                    stroke={CHART_COLORS[1]}
                    name="Duration (s)"
                  />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          )}

          {metrics?.resourceMetrics && metrics.resourceMetrics.length > 0 && (
            <Card>
              <SectionHeading level={3}>Resource Metrics</SectionHeading>
              <div className="space-y-4">
                {metrics.resourceMetrics.map((metric) => (
                  <div key={metric.resourceId} className="p-4 rounded-md border border-[var(--hh-border)]">
                    <SectionHeading level={4}>{metric.resourceId}</SectionHeading>
                    <div className="grid grid-cols-3 gap-4">
                      <div>
                        <div className={`text-sm ${MUTED}`}>Records Extracted</div>
                        <div className="text-xl font-bold">
                          {metric.totalRecordsExtracted.toLocaleString()}
                        </div>
                      </div>
                      <div>
                        <div className={`text-sm ${MUTED}`}>Success Rate</div>
                        <div className="text-xl font-bold">{metric.successRate.toFixed(1)}%</div>
                      </div>
                      <div>
                        <div className={`text-sm ${MUTED}`}>Avg Duration</div>
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
        </TabPanel>
      </div>

      {/* Delete Dialog */}
      <ConfirmDialog
        open={showDeleteDialog}
        title="Delete Configuration"
        body="Are you sure you want to delete this connector configuration? This action cannot be undone."
        tone="danger"
        confirmLabel={deleting ? 'Deleting...' : 'Delete'}
        cancelLabel="Cancel"
        onConfirm={handleDelete}
        onCancel={() => {
          if (!deleting) setShowDeleteDialog(false);
        }}
      />
    </div>
  );
}
