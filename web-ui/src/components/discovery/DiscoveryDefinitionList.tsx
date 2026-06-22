// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import {
  DiscoveryProvider,
  DiscoveryDefinition,
  DiscoveryDefinitionInput,
} from '../../services/discovery.service';
import { Button } from '../ui/button';
import { LiquidGlass } from '../ui/liquid-glass';
import { Icon } from '@happy-technologies/design-system';
import DiscoveryDefinitionForm from './DiscoveryDefinitionForm';
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
} from '../ui/form-dialog';
import { Badge } from '../ui/badge';
import { Switch } from '../ui/switch';

interface DiscoveryDefinitionListProps {
  definitions: DiscoveryDefinition[];
  loading: boolean;
  onCreateDefinition: (data: DiscoveryDefinitionInput) => Promise<void>;
  onUpdateDefinition: (id: string, data: Partial<DiscoveryDefinitionInput>) => Promise<void>;
  onDeleteDefinition: (id: string) => Promise<void>;
  onRunDefinition: (id: string) => Promise<void>;
  onToggleSchedule: (id: string, enabled: boolean) => Promise<void>;
}

const PROVIDERS: DiscoveryProvider[] = [
  'nmap',
  'ssh',
  'active-directory',
  'snmp',
];

export const DiscoveryDefinitionList: React.FC<DiscoveryDefinitionListProps> = ({
  definitions,
  loading,
  onCreateDefinition,
  onUpdateDefinition,
  onDeleteDefinition,
  onRunDefinition,
  onToggleSchedule,
}) => {
  const [search, setSearch] = useState('');
  const [filterProvider, setFilterProvider] = useState<DiscoveryProvider | 'all'>('all');
  const [filterActive, setFilterActive] = useState<'all' | 'active' | 'inactive'>('all');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingDefinition, setEditingDefinition] = useState<DiscoveryDefinition | null>(null);
  const [deletingDefinition, setDeletingDefinition] = useState<DiscoveryDefinition | null>(null);

  const filteredDefinitions = definitions.filter((def) => {
    if (search && !def.name.toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
    if (filterProvider !== 'all' && def.provider !== filterProvider) {
      return false;
    }
    if (filterActive === 'active' && !def.active) {
      return false;
    }
    if (filterActive === 'inactive' && def.active) {
      return false;
    }
    return true;
  });

  const handleCreate = async (data: DiscoveryDefinitionInput) => {
    await onCreateDefinition(data);
    setShowCreateDialog(false);
  };

  const handleEdit = (definition: DiscoveryDefinition) => {
    setEditingDefinition(definition);
  };

  const handleUpdate = async (data: DiscoveryDefinitionInput) => {
    if (editingDefinition) {
      await onUpdateDefinition(editingDefinition.id, data);
      setEditingDefinition(null);
    }
  };

  const handleDelete = async () => {
    if (deletingDefinition) {
      await onDeleteDefinition(deletingDefinition.id);
      setDeletingDefinition(null);
    }
  };

  const formatLabel = (value: string) => {
    return value
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
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

  const getCronDescription = (cronExpression?: string): string => {
    if (!cronExpression) return 'Not scheduled';

    const parts = cronExpression.split(' ');
    if (parts.length !== 5) return cronExpression;

    const [min, hour, day, month, weekday] = parts;
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    if (min === '*' && hour === '*') return 'Every minute';
    if (hour === '*' && day === '*' && weekday === '*') return `Every hour at ${min} minutes past`;
    if (day === '*' && weekday === '*') {
      const timeStr = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
      return `Daily at ${timeStr}`;
    }
    if (day === '*' && weekday !== '*') {
      const timeStr = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
      const dayName = days[parseInt(weekday)] || weekday;
      return `Weekly on ${dayName} at ${timeStr}`;
    }
    if (day !== '*') {
      const timeStr = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
      return `Monthly on day ${day} at ${timeStr}`;
    }

    return cronExpression;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Discovery Definitions</h2>
          <p className="text-sm text-muted-foreground">
            Manage reusable discovery configurations
          </p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)}>
          <Icon name="plus" size={16} className="mr-2" />
          Create Definition
        </Button>
      </div>

      <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
        {/* Filters */}
        <div className="p-4 flex flex-wrap gap-3 items-center border-b border-border/50">
          <div className="relative flex-1 min-w-[250px]">
            <Icon name="magnifying-glass" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search definitions..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-3 py-2 border border-input rounded-md text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="relative min-w-[150px]">
            <Icon name="funnel" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <select
              value={filterProvider}
              onChange={(e) => setFilterProvider(e.target.value as DiscoveryProvider | 'all')}
              className="w-full pl-10 pr-8 py-2 border border-input rounded-md text-sm appearance-none bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All Providers</option>
              {PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {provider.toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          <select
            value={filterActive}
            onChange={(e) => setFilterActive(e.target.value as 'all' | 'active' | 'inactive')}
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
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Name
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Provider
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Schedule
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Last Run
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center">
                    <div className="flex justify-center">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                    </div>
                  </td>
                </tr>
              ) : filteredDefinitions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {definitions.length === 0
                      ? 'No discovery definitions found. Create your first definition to get started.'
                      : 'No definitions match the current filters.'}
                  </td>
                </tr>
              ) : (
                filteredDefinitions.map((definition) => (
                  <tr
                    key={definition.id}
                    className="hover:bg-muted/50 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div>
                        <span className="text-sm font-medium text-foreground">{definition.name}</span>
                        {definition.description && (
                          <p className="text-xs text-muted-foreground mt-0.5 max-w-[300px] truncate">
                            {definition.description}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline">{definition.provider.toUpperCase()}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={definition.active ? 'default' : 'secondary'}>
                        {definition.active ? 'Active' : 'Inactive'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={definition.schedule?.enabled || false}
                          onCheckedChange={(checked) => onToggleSchedule(definition.id, checked)}
                          className="scale-75"
                        />
                        <span className="text-sm text-foreground">
                          {getCronDescription(definition.schedule?.cronExpression)}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <span className="text-sm text-muted-foreground">
                          {formatDate(definition.lastRunAt)}
                        </span>
                        {definition.lastRunStatus && (
                          <Badge
                            variant={definition.lastRunStatus === 'completed' ? 'secondary' : 'destructive'}
                            className="ml-2 text-xs"
                          >
                            {definition.lastRunStatus}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => onRunDefinition(definition.id)}
                          className="p-1.5 hover:bg-primary/10 rounded transition-colors"
                          title="Run Now"
                        >
                          <Icon name="play" size={16} className="text-primary" />
                        </button>
                        <button
                          onClick={() => handleEdit(definition)}
                          className="p-1.5 hover:bg-primary/10 rounded transition-colors"
                          title="Edit"
                        >
                          <Icon name="pencil-simple" size={16} className="text-primary" />
                        </button>
                        <button
                          onClick={() => setDeletingDefinition(definition)}
                          className="p-1.5 hover:bg-destructive/10 rounded transition-colors"
                          title="Delete"
                        >
                          <Icon name="trash" size={16} className="text-destructive" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-4 py-3 flex items-center justify-between border-t border-border/50">
          <div className="flex items-center gap-2">
            <span className="text-sm text-foreground">
              {filteredDefinitions.length} of {definitions.length} definitions
            </span>
          </div>
        </div>
      </LiquidGlass>

      {/* Create Dialog */}
      <FormDialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <FormDialogContent>
          <FormDialogHeader>
            <FormDialogTitle>Create Discovery Definition</FormDialogTitle>
          </FormDialogHeader>
          <FormDialogBody>
            <DiscoveryDefinitionForm
              onSubmit={handleCreate}
              onCancel={() => setShowCreateDialog(false)}
            />
          </FormDialogBody>
        </FormDialogContent>
      </FormDialog>

      {/* Edit Dialog */}
      <FormDialog
        open={!!editingDefinition}
        onOpenChange={(open) => !open && setEditingDefinition(null)}
      >
        <FormDialogContent>
          <FormDialogHeader>
            <FormDialogTitle>Edit Discovery Definition</FormDialogTitle>
          </FormDialogHeader>
          <FormDialogBody>
            {editingDefinition && (
              <DiscoveryDefinitionForm
                definition={editingDefinition}
                onSubmit={handleUpdate}
                onCancel={() => setEditingDefinition(null)}
              />
            )}
          </FormDialogBody>
        </FormDialogContent>
      </FormDialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deletingDefinition} onOpenChange={(open) => !open && setDeletingDefinition(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Definition</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deletingDefinition?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingDefinition(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default DiscoveryDefinitionList;
