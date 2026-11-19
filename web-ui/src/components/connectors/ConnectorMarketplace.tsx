// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector Marketplace Component
 * Browse, configure, and deploy ITSM/ticketing system integration connectors
 * For cloud infrastructure discovery, use the Discovery page instead
 */

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { connectorRunErrorMessage, connectorsApi } from '../../api/connectors';
import {
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  IconButton,
  IconWell,
  SectionHeading,
  Skeleton,
} from '@happy-technologies/design-system';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { ConnectorConfigModal } from './ConnectorConfigModal';
import { RequirePermission } from '@/components/common/RequirePermission';
import { QueryState } from '@/components/estate/SurfaceState';

const STATUS_TONE: Record<string, 'success' | 'danger' | 'neutral'> = {
  active: 'success',
  inactive: 'neutral',
  error: 'danger',
};

interface ConnectorTemplate {
  type: string;
  name: string;
  description: string;
  icon: string;
  category: 'itsm' | 'cloud' | 'monitoring' | 'custom';
  config_schema: Record<string, any>;
}

const CONNECTOR_TEMPLATES: ConnectorTemplate[] = [
  {
    type: 'servicenow',
    name: 'ServiceNow CMDB',
    description: 'Bi-directional sync with ServiceNow CMDB for CI synchronization and relationship management',
    icon: '🔷',
    category: 'itsm',
    config_schema: {
      instance_url: { type: 'string', required: true, label: 'Instance URL' },
      username: { type: 'string', required: true, label: 'Username' },
      password: { type: 'password', required: true, label: 'Password' },
      table: { type: 'string', required: false, label: 'CMDB Table (default: cmdb_ci)' },
      sync_direction: { type: 'select', required: false, label: 'Sync Direction', options: ['import', 'export', 'bidirectional'] },
    },
  },
  {
    type: 'jira',
    name: 'Jira Asset Management',
    description: 'Import assets and link to projects for tracking infrastructure-to-application relationships',
    icon: '📘',
    category: 'itsm',
    config_schema: {
      instance_url: { type: 'string', required: true, label: 'Jira URL' },
      email: { type: 'string', required: true, label: 'Email' },
      api_token: { type: 'password', required: true, label: 'API Token' },
      asset_schema_id: { type: 'string', required: false, label: 'Asset Schema ID' },
      jql_filter: { type: 'string', required: false, label: 'JQL Filter' },
    },
  },
  {
    type: 'bmc_remedy',
    name: 'BMC Remedy',
    description: 'Import CIs from BMC Remedy CMDB (coming soon)',
    icon: '🔶',
    category: 'itsm',
    config_schema: {
      server_url: { type: 'string', required: true, label: 'Remedy Server URL' },
      username: { type: 'string', required: true, label: 'Username' },
      password: { type: 'password', required: true, label: 'Password' },
    },
  },
  {
    type: 'datadog',
    name: 'Datadog',
    description: 'Enrich CIs with monitoring metrics and APM data (coming soon)',
    icon: '🐕',
    category: 'monitoring',
    config_schema: {
      api_key: { type: 'password', required: true, label: 'API Key' },
      app_key: { type: 'password', required: true, label: 'Application Key' },
      site: { type: 'select', required: true, label: 'Site', options: ['datadoghq.com', 'datadoghq.eu'] },
    },
  },
  {
    type: 'splunk',
    name: 'Splunk',
    description: 'Enrich CIs with log data and operational intelligence (coming soon)',
    icon: '🔍',
    category: 'monitoring',
    config_schema: {
      server_url: { type: 'string', required: true, label: 'Splunk URL' },
      username: { type: 'string', required: true, label: 'Username' },
      password: { type: 'password', required: true, label: 'Password' },
    },
  },
  {
    type: 'custom',
    name: 'Custom Connector',
    description: 'Build your own integration with any REST API or data source',
    icon: '⚙️',
    category: 'custom',
    config_schema: {
      api_url: { type: 'string', required: true, label: 'API Base URL' },
      auth_type: {
        type: 'select',
        required: true,
        label: 'Authentication Type',
        options: ['none', 'basic', 'bearer', 'api_key', 'oauth2']
      },
      username: { type: 'string', required: false, label: 'Username (if using Basic Auth)' },
      password: { type: 'password', required: false, label: 'Password / API Key' },
      headers: { type: 'textarea', required: false, label: 'Custom Headers (JSON)' },
    },
  },
];

export const ConnectorMarketplace: React.FC = () => {
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [configuring, setConfiguring] = useState<ConnectorTemplate | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const connectorsQuery = useQuery({
    queryKey: ['connectors'],
    queryFn: connectorsApi.list,
  });
  const connectors = connectorsQuery.isError ? undefined : connectorsQuery.data;

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
    },
    onError: () => toast.error('Failed to delete connector'),
  });

  const categories = [
    { value: 'all', label: 'All Connectors' },
    { value: 'itsm', label: 'ITSM / Asset Management' },
    { value: 'monitoring', label: 'Monitoring & Observability' },
    { value: 'custom', label: 'Custom Integrations' },
  ];

  const filteredTemplates =
    selectedCategory === 'all'
      ? CONNECTOR_TEMPLATES
      : CONNECTOR_TEMPLATES.filter((t) => t.category === selectedCategory);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <SectionHeading level={2}>Connector Marketplace</SectionHeading>
        <p className="-mt-2 text-sm text-[var(--hh-text-muted)]">
          Deploy bi-directional integrations with ITSM, ticketing, and monitoring systems
        </p>
      </div>

      {/* Discovery Banner */}
      <Card>
        <div className="flex items-start gap-4">
          <IconWell icon="info" tone="accent" />
          <div className="flex-1">
            <SectionHeading level={3}>Looking for Cloud Infrastructure Discovery?</SectionHeading>
            <p className="-mt-2 mb-3 text-sm text-[var(--hh-text-muted)]">
              For discovering CIs from AWS, Azure, GCP, Kubernetes, SSH, and network devices, use the
              <strong> Discovery </strong> feature instead. Connectors are for bi-directional synchronization
              with external ITSM and monitoring platforms.
            </p>
            <Button onClick={() => navigate('/discovery')} size="sm" variant="outline" iconRight="arrow-right">
              Go to Discovery
            </Button>
          </div>
        </div>
      </Card>

      {/* Category Filter */}
      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
          <Chip
            key={cat.value}
            active={selectedCategory === cat.value}
            aria-pressed={selectedCategory === cat.value}
            onClick={() => setSelectedCategory(cat.value)}
          >
            {cat.label}
          </Chip>
        ))}
      </div>

      {/* Deployed Connectors */}
      <Card>
        <SectionHeading level={3}>Deployed Connectors</SectionHeading>
        {connectorsQuery.isPending ? (
          <div aria-busy="true" className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        ) : connectorsQuery.isError ? (
          <QueryState what="deployed connectors" error={connectorsQuery.error} onRetry={() => void connectorsQuery.refetch()} />
        ) : connectors && connectors.length === 0 ? (
          <EmptyState icon="plugs" title="No connectors deployed yet" />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {(connectors ?? []).map((connector) => (
              <Card key={connector.id}>
                <div className="mb-3 flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <span aria-hidden="true" className="text-2xl">
                      {CONNECTOR_TEMPLATES.find((t) => t.type === connector.type)?.icon || '🔌'}
                    </span>
                    <div>
                      <h4 className="font-semibold">{connector.name}</h4>
                      <Badge variant="neutral" className="mt-1 capitalize">
                        {connector.type}
                      </Badge>
                    </div>
                  </div>
                  <Badge variant={STATUS_TONE[connector.status] ?? 'neutral'} dot>
                    {connector.status}
                  </Badge>
                </div>

                <div className="mb-3 text-sm text-[var(--hh-text-muted)]">
                  Updated: {new Date(connector.updated_at).toLocaleString()}
                </div>

                <RequirePermission permission="write">
                  <div className="flex gap-2">
                    <Button
                      onClick={() => runMutation.mutate(connector.id)}
                      disabled={runMutation.isPending}
                      className="flex-1"
                      size="sm"
                      icon="play"
                    >
                      Run Now
                    </Button>
                    <IconButton
                      onClick={() => {
                        /* TODO: Open config modal */
                      }}
                      variant="outline"
                      size="sm"
                      icon="gear-six"
                      aria-label={`Configure ${connector.name}`}
                    />
                    <IconButton
                      onClick={() => deleteMutation.mutate(connector.id)}
                      variant="outline"
                      size="sm"
                      icon="trash"
                      aria-label={`Delete ${connector.name}`}
                    />
                  </div>
                </RequirePermission>
              </Card>
            ))}
          </div>
        )}
      </Card>

      {/* Available Templates */}
      <Card>
        <SectionHeading level={3}>Available Connectors</SectionHeading>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredTemplates.map((template) => (
            <Card key={template.type}>
              <div className="mb-4 flex items-start gap-3">
                <span aria-hidden="true" className="text-3xl">{template.icon}</span>
                <div className="flex-1">
                  <h4 className="font-semibold">{template.name}</h4>
                  <p className="mt-1 text-sm text-[var(--hh-text-muted)]">{template.description}</p>
                </div>
              </div>
              {/* Deploys via POST /connector-configs (requirePermission('write')) */}
              <RequirePermission permission="write">
                <Button onClick={() => setConfiguring(template)} className="w-full">
                  Deploy Connector
                </Button>
              </RequirePermission>
            </Card>
          ))}
        </div>
      </Card>

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
    </div>
  );
};
