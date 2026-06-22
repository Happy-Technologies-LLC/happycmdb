// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector Marketplace Component
 * Browse, configure, and deploy ITSM/ticketing system integration connectors
 * For cloud infrastructure discovery, use the Discovery page instead
 */

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { connectorsApi } from '../../api/connectors';
import { Connector } from '../../types';
import { Icon } from '@happy-technologies/design-system';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Badge } from '@/components/ui/badge';
import { useNavigate } from 'react-router-dom';
import { ConnectorConfigModal } from './ConnectorConfigModal';

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

  const { data: connectors, isLoading } = useQuery({
    queryKey: ['connectors'],
    queryFn: connectorsApi.list,
  });

  const runMutation = useMutation({
    mutationFn: (connectorName: string) => connectorsApi.run(connectorName),
    onSuccess: () => {
      toast.success('Connector started successfully');
      queryClient.invalidateQueries({ queryKey: ['connectors'] });
    },
    onError: () => toast.error('Failed to start connector'),
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

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'active':
        return <Icon name="check-circle" size={20} className="text-success" />;
      case 'inactive':
        return <Icon name="clock" size={20} className="text-ink-soft" />;
      case 'error':
        return <Icon name="x-circle" size={20} className="text-danger" />;
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Connector Marketplace</h2>
        <p className="text-muted-foreground mt-1">
          Deploy bi-directional integrations with ITSM, ticketing, and monitoring systems
        </p>
      </div>

      {/* Discovery Banner */}
      <LiquidGlass variant="default" rounded="xl" className="border-l-4 border-l-sky">
        <div className="flex items-start gap-4">
          <div className="p-2 bg-sky-soft rounded-lg">
            <Icon name="info" size={24} className="text-sky-text" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-lg mb-1">Looking for Cloud Infrastructure Discovery?</h3>
            <p className="text-sm text-muted-foreground mb-3">
              For discovering CIs from AWS, Azure, GCP, Kubernetes, SSH, and network devices, use the
              <strong> Discovery </strong> feature instead. Connectors are for bi-directional synchronization
              with external ITSM and monitoring platforms.
            </p>
            <Button
              onClick={() => navigate('/discovery')}
              size="sm"
              variant="outline"
            >
              Go to Discovery
              <Icon name="arrow-right" size={16} className="ml-2" />
            </Button>
          </div>
        </div>
      </LiquidGlass>

      {/* Category Filter */}
      <div className="flex gap-2 flex-wrap">
        {categories.map((cat) => (
          <Button
            key={cat.value}
            onClick={() => setSelectedCategory(cat.value)}
            variant={selectedCategory === cat.value ? 'default' : 'outline'}
          >
            {cat.label}
          </Button>
        ))}
      </div>

      {/* Deployed Connectors */}
      {connectors && connectors.length > 0 && (
        <LiquidGlass variant="default" rounded="xl">
          <h3 className="text-lg font-semibold mb-4">Deployed Connectors</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {connectors.map((connector) => (
              <div
                key={connector.id}
                className="p-4 border border-border rounded-lg hover:bg-accent/50 transition-colors"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">
                      {CONNECTOR_TEMPLATES.find((t) => t.type === connector.type)?.icon || '🔌'}
                    </span>
                    <div>
                      <h4 className="font-semibold">{connector.name}</h4>
                      <Badge variant="outline" className="mt-1 capitalize">
                        {connector.type}
                      </Badge>
                    </div>
                  </div>
                  {getStatusIcon(connector.status)}
                </div>

                <div className="text-sm text-muted-foreground mb-3">
                  Last run:{' '}
                  {connector.last_run_at
                    ? new Date(connector.last_run_at).toLocaleString()
                    : 'Never'}
                </div>

                <div className="flex gap-2">
                  <Button
                    onClick={() => runMutation.mutate(connector.name)}
                    disabled={runMutation.isPending}
                    className="flex-1"
                    size="sm"
                  >
                    <Icon name="play" size={16} />
                    Run Now
                  </Button>
                  <Button
                    onClick={() => {
                      /* TODO: Open config modal */
                    }}
                    variant="outline"
                    size="sm"
                  >
                    <Icon name="gear-six" size={16} />
                  </Button>
                  <Button
                    onClick={() => deleteMutation.mutate(connector.id)}
                    variant="destructive"
                    size="sm"
                  >
                    <Icon name="trash" size={16} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </LiquidGlass>
      )}

      {/* Available Templates */}
      <LiquidGlass variant="default" rounded="xl">
        <h3 className="text-lg font-semibold mb-4">Available Connectors</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredTemplates.map((template) => (
            <div
              key={template.type}
              className="p-4 border border-border rounded-lg hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-start gap-3 mb-4">
                <span className="text-3xl">{template.icon}</span>
                <div className="flex-1">
                  <h4 className="font-semibold">{template.name}</h4>
                  <p className="text-sm text-muted-foreground mt-1">{template.description}</p>
                </div>
              </div>
              <Button
                onClick={() => setConfiguring(template)}
                className="w-full"
              >
                Deploy Connector
              </Button>
            </div>
          ))}
        </div>
      </LiquidGlass>

      {/* Configuration Modal */}
      {configuring && (
        <ConnectorConfigModal
          template={configuring}
          onClose={() => setConfiguring(null)}
          onDeploy={(config) => {
            console.log('Deploying connector:', config);
            toast.success(`${configuring.name} connector deployed!`);
            setConfiguring(null);
            queryClient.invalidateQueries({ queryKey: ['connectors'] });
          }}
        />
      )}
    </div>
  );
};
