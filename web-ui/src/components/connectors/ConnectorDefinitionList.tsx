// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useMemo, useId } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { connectorRunErrorMessage, connectorsApi } from '../../api/connectors';
import {
  Badge,
  Button,
  Card,
  Chip,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  Input,
  SectionHeading,
  Select,
  Switch,
  type Column,
} from '@happy-technologies/design-system';
import { ConnectorConfigModal } from './ConnectorConfigModal';
import { toast } from 'sonner';
import { RequirePermission } from '@/components/common/RequirePermission';
import { QueryState } from '@/components/estate/SurfaceState';

interface ConnectorTemplate {
  type: string;
  name: string;
  description: string;
  icon: string;
  category: 'itsm' | 'cloud' | 'monitoring' | 'custom';
  config_schema: Record<string, any>;
}

// Icon mapping for connector types
const CONNECTOR_ICONS: Record<string, string> = {
  servicenow: '🔷',
  jira: '📘',
  sccm: '🪟',
  intune: '📱',
  jamf: '🍎',
  crowdstrike: '🦅',
  defender: '🛡️',
  datadog: '🐕',
  dynatrace: '📊',
  appdynamics: '📈',
  tenable: '🔒',
  infoblox: '🌐',
  cisco_meraki: '📡',
  wiz: '☁️',
  veeam: '💾',
  rubrik: '📦',
  prometheus: '🔥',
  bmc_remedy: '🔶',
  splunk: '🔍',
  custom: '⚙️',
};

// Category mapping based on connector metadata
const getCategoryFromTags = (tags: string[] = []): 'itsm' | 'cloud' | 'monitoring' | 'custom' => {
  if (tags.some(t => ['itsm', 'ticketing', 'cmdb'].includes(t.toLowerCase()))) return 'itsm';
  if (tags.some(t => ['monitoring', 'apm', 'observability'].includes(t.toLowerCase()))) return 'monitoring';
  if (tags.some(t => ['cloud', 'infrastructure'].includes(t.toLowerCase()))) return 'cloud';
  return 'custom';
};

// Transform API connector to UI template format
const transformConnectorToTemplate = (connector: any): ConnectorTemplate => {
  const connectionSchema = connector.configuration_schema?.properties || connector.connection_schema?.properties || {};

  // Transform schema to config_schema format expected by modal
  const config_schema: Record<string, any> = {};
  Object.entries(connectionSchema).forEach(([key, schema]: [string, any]) => {
    config_schema[key] = {
      type: schema.type === 'boolean' ? 'checkbox' : schema.type === 'integer' ? 'number' : schema.format === 'password' ? 'password' : 'string',
      required: schema.required || false,
      label: schema.title || key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      description: schema.description,
      default: schema.default,
      options: schema.enum,
      // HAP-1895: the modal picks SecretInput/SecretTextarea from these, not from `type`.
      format: schema.format,
      sensitive: schema.sensitive === true,
    };
  });

  return {
    type: connector.connector_type,
    name: connector.name,
    description: connector.description || '',
    icon: CONNECTOR_ICONS[connector.connector_type] || '🔌',
    category: connector.category?.toLowerCase() === 'connector' ? getCategoryFromTags(connector.tags) : 'custom',
    config_schema,
  };
};

export const ConnectorDefinitionList: React.FC = () => {
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [showMarketplace, setShowMarketplace] = useState(false);
  const [configuring, setConfiguring] = useState<ConnectorTemplate | null>(null);
  const [deletingConnector, setDeletingConnector] = useState<any>(null);
  const queryClient = useQueryClient();

  // Fetch installed connectors (available templates)
  const installedQuery = useQuery({
    queryKey: ['connectors', 'installed'],
    queryFn: connectorsApi.listInstalled,
  });
  const { data: installedConnectors = [], isLoading: loadingInstalled } = installedQuery;

  // Fetch configured connectors (deployed instances)
  const configsQuery = useQuery({
    queryKey: ['connectors'],
    queryFn: connectorsApi.list,
  });
  const { data: connectors = [], isLoading: loadingConfigs } = configsQuery;

  // Transform API connectors to UI templates
  const CONNECTOR_TEMPLATES = useMemo(() => {
    return installedConnectors.map(transformConnectorToTemplate);
  }, [installedConnectors]);

  const isLoading = loadingInstalled || loadingConfigs;

  const runMutation = useMutation({
    mutationFn: (configId: string) => connectorsApi.run(configId),
    onSuccess: () => {
      toast.success('Connector started successfully');
      queryClient.invalidateQueries({ queryKey: ['connectors'] });
    },
    onError: (error) => toast.error(connectorRunErrorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => connectorsApi.delete(id),
    onSuccess: () => {
      toast.success('Connector deleted');
      queryClient.invalidateQueries({ queryKey: ['connectors'] });
      setDeletingConnector(null);
    },
    onError: () => toast.error('Failed to delete connector'),
  });

  const filteredConnectors = connectors.filter((conn) => {
    if (search && !conn.name.toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
    if (filterCategory !== 'all' && conn.type !== filterCategory) {
      return false;
    }
    if (filterStatus === 'active' && conn.status !== 'active') {
      return false;
    }
    if (filterStatus === 'inactive' && conn.status === 'active') {
      return false;
    }
    return true;
  });

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'active':
        return <Icon name="check-circle" size={20} className="text-[var(--hh-success-text)]" />;
      case 'inactive':
        return <Icon name="clock" size={20} className="text-[var(--hh-text-muted)]" />;
      case 'error':
        return <Icon name="x-circle" size={20} className="text-[var(--hh-error-text)]" />;
      default:
        return null;
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return 'Never';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const marketplaceTitleId = useId();

  const matchesMarketplaceFilters = (template: ConnectorTemplate) => {
    // Search filter
    if (search && !template.name.toLowerCase().includes(search.toLowerCase()) &&
        !template.type.toLowerCase().includes(search.toLowerCase()) &&
        !template.description.toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
    // Category filter
    if (filterCategory !== 'all' && template.category !== filterCategory) {
      return false;
    }
    return true;
  };
  const marketplaceTemplates = CONNECTOR_TEMPLATES.filter(matchesMarketplaceFilters);

  const columns: Array<Column<(typeof connectors)[number]>> = [
    {
      header: 'Name',
      render: (connector) => (
        <div className="flex items-center gap-2">
          <span className="text-xl">
            {CONNECTOR_TEMPLATES.find((t) => t.type === connector.type)?.icon || '🔌'}
          </span>
          <div>
            <span className="text-sm font-medium text-[var(--hh-text-primary)]">{connector.name}</span>
            {connector.description && (
              <p className="mt-0.5 max-w-[300px] truncate text-xs text-[var(--hh-text-muted)]">
                {connector.description}
              </p>
            )}
          </div>
        </div>
      ),
    },
    {
      header: 'Type',
      render: (connector) => <Badge variant="neutral" className="capitalize">{connector.type}</Badge>,
    },
    {
      header: 'Status',
      render: (connector) => (
        <div className="flex items-center gap-2">
          {getStatusIcon(connector.status)}
          <Badge variant={connector.status === 'active' ? 'success' : connector.status === 'error' ? 'danger' : 'neutral'}>
            {connector.status === 'active' ? 'Active' : connector.status === 'error' ? 'Error' : 'Inactive'}
          </Badge>
        </div>
      ),
    },
    {
      header: 'Schedule',
      render: (connector) => (
        <div className="flex items-center gap-2">
          {/* Display only: toggling the schedule is not wired here, so the switch is disabled. */}
          <Switch
            checked={connector.schedule_enabled || false}
            disabled
            onChange={() => {}}
            aria-label={`Schedule for ${connector.name}`}
          />
          <span className="text-sm text-[var(--hh-text-primary)]">
            {connector.schedule_enabled ? 'Enabled' : 'Disabled'}
          </span>
        </div>
      ),
    },
    {
      header: 'Updated',
      render: (connector) => (
        <span className="text-sm text-[var(--hh-text-muted)]">{formatDate(connector.updated_at)}</span>
      ),
    },
    {
      header: 'Actions',
      className: 'text-right',
      render: (connector) => (
        <RequirePermission permission="write">
          <div className="flex justify-end gap-1">
            <IconButton
              icon="play"
              variant="ghost"
              aria-label="Run Now"
              title="Run Now"
              onClick={() => runMutation.mutate(connector.id)}
            />
            <IconButton
              icon="pencil-simple"
              variant="ghost"
              aria-label="Edit"
              title="Edit"
              onClick={() => {/* TODO: Open edit modal */}}
            />
            <IconButton
              icon="trash"
              variant="ghost"
              aria-label="Delete"
              title="Delete"
              onClick={() => setDeletingConnector(connector)}
            />
          </div>
        </RequirePermission>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header with Install Button */}
      <div>
        <SectionHeading
          level={2}
          className="mb-1"
          right={
            /* Deploys via POST /connector-configs (requirePermission('write')) */
            <RequirePermission permission="write">
              <Button onClick={() => setShowMarketplace(true)} size="lg" icon="plus">
                Install Connector
              </Button>
            </RequirePermission>
          }
        >
          Connector Definitions
        </SectionHeading>
        <p className="text-sm text-[var(--hh-text-muted)]">
          Manage deployed connector configurations
        </p>
      </div>

      <div className="space-y-3">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <Input
            type="text"
            icon="magnifying-glass"
            aria-label="Search connectors"
            placeholder="Search connectors..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            containerClassName="min-w-[250px] flex-1"
          />

          <Select
            aria-label="Filter by connector type"
            value={filterCategory}
            onChange={setFilterCategory}
            options={[
              { value: 'all', label: 'All Types' },
              ...CONNECTOR_TEMPLATES.map((template) => ({ value: template.type, label: template.name })),
            ]}
          />

          <Select
            aria-label="Filter by status"
            value={filterStatus}
            onChange={(value) => setFilterStatus(value as 'all' | 'active' | 'inactive')}
            options={[
              { value: 'all', label: 'All Status' },
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
            ]}
          />
        </div>

        {/* Table */}
        {configsQuery.isError ? (
          <QueryState
            what="connector definitions"
            error={configsQuery.error}
            onRetry={() => void configsQuery.refetch()}
          />
        ) : (
          <DataTable
            rows={filteredConnectors}
            columns={columns}
            rowKey={(connector) => connector.id}
            loading={isLoading}
            emptyLabel={
              connectors.length === 0
                ? 'No connectors deployed yet. Deploy your first connector to get started.'
                : 'No connectors match the current filters.'
            }
            footer={<span className="text-sm text-[var(--hh-text-primary)]">{filteredConnectors.length} of {connectors.length} connectors</span>}
          />
        )}
      </div>

      {/* Connector Marketplace Modal */}
      <Dialog
        open={showMarketplace}
        onClose={() => setShowMarketplace(false)}
        aria-labelledby={marketplaceTitleId}
        className="flex max-h-[90vh] flex-col"
        style={{ maxWidth: '72rem' }}
      >
        <div className="border-b border-[var(--hh-hairline)] p-6 pr-16">
          <SectionHeading id={marketplaceTitleId} level={2} className="mb-1">
            Install Connector
          </SectionHeading>
          <p className="text-sm text-[var(--hh-text-muted)]">
            Browse and install integration connectors for your CMDB
          </p>
        </div>

        <div className="flex min-h-0 flex-1 flex-col space-y-4 p-6">
          {/* Search Bar */}
          <Input
            type="text"
            icon="magnifying-glass"
            aria-label="Search available connectors"
            placeholder="Search connectors by name, type, or category..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          {/* Category Filter Chips */}
          <div className="flex flex-wrap gap-2 border-b border-[var(--hh-hairline)] pb-4">
            {['all', 'itsm', 'monitoring', 'cloud', 'custom'].map((cat) => (
              <Chip key={cat} active={filterCategory === cat} onClick={() => setFilterCategory(cat)}>
                {cat === 'all' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1)}
              </Chip>
            ))}
          </div>

          {/* Connector Grid - Scrollable */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loadingInstalled ? (
              <EmptyState loading label="Loading connectors..." />
            ) : installedQuery.isError ? (
              <QueryState
                what="installed connectors"
                error={installedQuery.error}
                onRetry={() => void installedQuery.refetch()}
              />
            ) : marketplaceTemplates.length === 0 ? (
              <EmptyState label="No connectors match the current filters." />
            ) : (
              <div className="grid grid-cols-1 gap-4 pb-4 md:grid-cols-2 lg:grid-cols-3">
                {marketplaceTemplates.map((template) => (
                  <Card key={template.type}>
                    <div className="flex items-start gap-3">
                      <span className="text-3xl">{template.icon}</span>
                      <div className="flex-1">
                        <SectionHeading level={3} className="mb-0 !text-base !font-semibold">
                          {template.name}
                        </SectionHeading>
                        <p className="mt-1 line-clamp-3 text-xs text-[var(--hh-text-muted)]">
                          {template.description}
                        </p>
                        <div className="mt-3 flex items-center justify-between">
                          <Badge variant="neutral" className="capitalize">{template.category}</Badge>
                          <Button
                            size="sm"
                            icon="plus"
                            onClick={() => {
                              setConfiguring(template);
                              setShowMarketplace(false);
                            }}
                          >
                            Deploy
                          </Button>
                        </div>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-[var(--hh-hairline)] pt-4">
            <span className="text-sm text-[var(--hh-text-muted)]">
              {marketplaceTemplates.length} of {CONNECTOR_TEMPLATES.length} connectors
            </span>
            <Button variant="outline" onClick={() => setShowMarketplace(false)}>
              Close
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Configuration Modal */}
      {configuring && (
        <ConnectorConfigModal
          template={configuring}
          onClose={() => setConfiguring(null)}
          onDeploy={async (config) => {
            try {
              await connectorsApi.create({
                name: config.name,
                connector_type: config.type,
                enabled: config.enabled,
                schedule: config.schedule.cron_expression,
                schedule_enabled: config.schedule.enabled,
                connection: config.connection,
                enabled_resources: config.enabled_resources,
                resource_configs: config.field_mappings,
              });
              toast.success(`${configuring.name} connector deployed!`);
              setConfiguring(null);
              queryClient.invalidateQueries({ queryKey: ['connectors'] });
            } catch {
              toast.error('Failed to deploy connector');
            }
          }}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={!!deletingConnector}
        tone="danger"
        title="Delete Connector"
        body={`Are you sure you want to delete "${deletingConnector?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => deleteMutation.mutate(deletingConnector.id)}
        onCancel={() => setDeletingConnector(null)}
      />
    </div>
  );
};

export default ConnectorDefinitionList;
