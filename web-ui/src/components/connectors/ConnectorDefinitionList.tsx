// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { connectorsApi } from '../../api/connectors';
import { Button } from '../ui/button';
import { LiquidGlass } from '../ui/liquid-glass';
import { Plus, Search, Filter, Pencil, Trash2, Play, CheckCircle, XCircle, Clock } from 'lucide-react';
import { ConnectorConfigModal } from './ConnectorConfigModal';
import { toast } from 'sonner';
import { Badge } from '../ui/badge';
import { Switch } from '../ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import {
  FormDialog,
  FormDialogContent,
  FormDialogHeader,
  FormDialogBody,
  FormDialogTitle,
  FormDialogDescription,
} from '../ui/form-dialog';

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
  const { data: installedConnectors = [], isLoading: loadingInstalled } = useQuery({
    queryKey: ['connectors', 'installed'],
    queryFn: connectorsApi.listInstalled,
  });

  // Fetch configured connectors (deployed instances)
  const { data: connectors = [], isLoading: loadingConfigs } = useQuery({
    queryKey: ['connectors'],
    queryFn: connectorsApi.list,
  });

  // Transform API connectors to UI templates
  const CONNECTOR_TEMPLATES = useMemo(() => {
    return installedConnectors.map(transformConnectorToTemplate);
  }, [installedConnectors]);

  const isLoading = loadingInstalled || loadingConfigs;

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
        return <CheckCircle className="h-5 w-5 text-success" />;
      case 'inactive':
        return <Clock className="h-5 w-5 text-ink-soft" />;
      case 'error':
        return <XCircle className="h-5 w-5 text-danger" />;
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

  return (
    <div className="space-y-6">
      {/* Header with Install Button */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Connector Definitions</h2>
          <p className="text-sm text-muted-foreground">
            Manage deployed connector configurations
          </p>
        </div>
        <Button onClick={() => setShowMarketplace(true)} size="lg">
          <Plus className="h-4 w-4 mr-2" />
          Install Connector
        </Button>
      </div>

      <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
        {/* Filters */}
        <div className="p-4 flex flex-wrap gap-3 items-center border-b border-border/50">
          <div className="relative flex-1 min-w-[250px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search connectors..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-3 py-2 border border-input rounded-md text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="relative min-w-[150px]">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <select
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              className="w-full pl-10 pr-8 py-2 border border-input rounded-md text-sm appearance-none bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All Types</option>
              {CONNECTOR_TEMPLATES.map((template) => (
                <option key={template.type} value={template.type}>
                  {template.name}
                </option>
              ))}
            </select>
          </div>

          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as 'all' | 'active' | 'inactive')}
            className="min-w-[150px] px-3 py-2 border border-input rounded-md text-sm appearance-none bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted/30 border-b border-border/50">
              <TableRow>
                <TableHead className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Name
                </TableHead>
                <TableHead className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Type
                </TableHead>
                <TableHead className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Status
                </TableHead>
                <TableHead className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Schedule
                </TableHead>
                <TableHead className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Last Run
                </TableHead>
                <TableHead className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Actions
                </TableHead>
              </TableRow>
            </thead>
            <tbody className="divide-y divide-border/30">
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="px-4 py-8 text-center">
                    <div className="flex justify-center">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                    </div>
                  </TableCell>
                </TableRow>
              ) : filteredConnectors.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {connectors.length === 0
                      ? 'No connectors deployed yet. Deploy your first connector to get started.'
                      : 'No connectors match the current filters.'}
                  </TableCell>
                </TableRow>
              ) : (
                filteredConnectors.map((connector) => (
                  <TableRow
                    key={connector.id}
                    className="hover:bg-muted/50 transition-colors"
                  >
                    <TableCell className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xl">
                          {CONNECTOR_TEMPLATES.find((t) => t.type === connector.type)?.icon || '🔌'}
                        </span>
                        <div>
                          <span className="text-sm font-medium text-foreground">{connector.name}</span>
                          {connector.description && (
                            <p className="text-xs text-muted-foreground mt-0.5 max-w-[300px] truncate">
                              {connector.description}
                            </p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <Badge variant="outline" className="capitalize">{connector.type}</Badge>
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(connector.status)}
                        <Badge variant={connector.status === 'active' ? 'default' : connector.status === 'error' ? 'destructive' : 'secondary'}>
                          {connector.status === 'active' ? 'Active' : connector.status === 'error' ? 'Error' : 'Inactive'}
                        </Badge>
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={connector.schedule_enabled || false}
                          className="scale-75"
                        />
                        <span className="text-sm text-foreground">
                          {connector.schedule_enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <span className="text-sm text-muted-foreground">
                        {formatDate(connector.last_run_at)}
                      </span>
                    </TableCell>
                    <TableCell className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => runMutation.mutate(connector.name)}
                          className="p-1.5 hover:bg-primary/10 rounded transition-colors"
                          title="Run Now"
                        >
                          <Play className="w-4 h-4 text-primary" />
                        </button>
                        <button
                          onClick={() => {/* TODO: Open edit modal */}}
                          className="p-1.5 hover:bg-primary/10 rounded transition-colors"
                          title="Edit"
                        >
                          <Pencil className="w-4 h-4 text-primary" />
                        </button>
                        <button
                          onClick={() => setDeletingConnector(connector)}
                          className="p-1.5 hover:bg-destructive/10 rounded transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Count */}
        <div className="px-4 py-3 flex items-center justify-between border-t border-border/50">
          <div className="flex items-center gap-2">
            <span className="text-sm text-foreground">
              {filteredConnectors.length} of {connectors.length} connectors
            </span>
          </div>
        </div>
      </LiquidGlass>

      {/* Connector Marketplace Modal */}
      <FormDialog open={showMarketplace} onOpenChange={setShowMarketplace}>
        <FormDialogContent className="max-w-6xl">
          <FormDialogHeader>
            <FormDialogTitle>Install Connector</FormDialogTitle>
            <FormDialogDescription>
              Browse and install integration connectors for your CMDB
            </FormDialogDescription>
          </FormDialogHeader>

          <FormDialogBody className="flex flex-col space-y-4">
            {/* Search Bar */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search connectors by name, type, or category..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-10 pr-3 py-2 border border-input rounded-md text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {/* Category Filter Chips */}
            <div className="flex gap-2 flex-wrap pb-4 border-b border-border/50">
              {['all', 'itsm', 'monitoring', 'cloud', 'custom'].map((cat) => (
                <button
                  key={cat}
                  onClick={() => setFilterCategory(cat)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                    filterCategory === cat
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  {cat === 'all' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1)}
                </button>
              ))}
            </div>

            {/* Connector Grid - Scrollable */}
            <div className="flex-1 overflow-y-auto min-h-0">
              {loadingInstalled ? (
                <div className="flex justify-center items-center h-64">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pb-4">
                {CONNECTOR_TEMPLATES.filter((template) => {
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
                }).map((template) => (
                  <LiquidGlass key={template.type} size="sm" rounded="lg" className="overflow-hidden hover:shadow-lg transition-all">
                    <div className="p-4">
                      <div className="flex items-start gap-3">
                        <span className="text-3xl">{template.icon}</span>
                        <div className="flex-1">
                          <h3 className="font-semibold text-foreground">{template.name}</h3>
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-3">
                            {template.description}
                          </p>
                          <div className="flex items-center justify-between mt-3">
                            <Badge variant="outline" className="capitalize">{template.category}</Badge>
                            <Button
                              size="sm"
                              onClick={() => {
                                setConfiguring(template);
                                setShowMarketplace(false);
                              }}
                            >
                              <Plus className="h-3 w-3 mr-1" />
                              Deploy
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </LiquidGlass>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between pt-4 border-t border-border/50">
              <span className="text-sm text-muted-foreground">
                {CONNECTOR_TEMPLATES.filter((t) => {
                  if (search && !t.name.toLowerCase().includes(search.toLowerCase()) &&
                      !t.type.toLowerCase().includes(search.toLowerCase()) &&
                      !t.description.toLowerCase().includes(search.toLowerCase())) {
                    return false;
                  }
                  if (filterCategory !== 'all' && t.category !== filterCategory) {
                    return false;
                  }
                  return true;
                }).length} of {CONNECTOR_TEMPLATES.length} connectors
              </span>
              <Button variant="outline" onClick={() => setShowMarketplace(false)}>
                Close
              </Button>
            </div>
          </FormDialogBody>
        </FormDialogContent>
      </FormDialog>

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

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deletingConnector} onOpenChange={(open) => !open && setDeletingConnector(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Connector</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deletingConnector?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingConnector(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => deleteMutation.mutate(deletingConnector.id)}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

// Helper components for table
const TableRow: React.FC<{ children: React.ReactNode; className?: string; onClick?: () => void }> = ({ children, className = '', onClick }) => (
  <tr className={className} onClick={onClick}>{children}</tr>
);

const TableHead: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <th className={className}>{children}</th>
);

const TableCell: React.FC<{ children: React.ReactNode; className?: string; colSpan?: number }> = ({ children, className = '', colSpan }) => (
  <td className={className} colSpan={colSpan}>{children}</td>
);

export default ConnectorDefinitionList;
