// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import {
  DiscoveryProvider,
  DiscoveryDefinition,
  DiscoveryDefinitionInput,
} from '../../services/discovery.service';
import {
  Badge,
  Banner,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  SectionHeading,
  Select,
  Switch,
  type Column,
} from '@happy-technologies/design-system';
import { RequirePermission } from '@/components/common/RequirePermission';
import { usePermission } from '@/hooks/usePermission';
import DiscoveryDefinitionForm from './DiscoveryDefinitionForm';

interface DiscoveryDefinitionListProps {
  definitions: DiscoveryDefinition[];
  loading: boolean;
  /** The read failed; shown instead of an empty list (never read as "no definitions"). */
  error?: string | null;
  /** The failed read was a 403: the server's reason, shown as a plain "not permitted" state. */
  forbiddenReason?: string | null;
  onRetry?: () => void;
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

const PROVIDER_FILTER_OPTIONS = [
  { value: 'all', label: 'All Providers' },
  ...PROVIDERS.map((provider) => ({ value: provider, label: provider.toUpperCase() })),
];

const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: 'All Status' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

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

/** A modal for the create/edit form; the body scrolls so a tall form never leaves the viewport. */
const FormModal: React.FC<{
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ open, title, onClose, children }) => (
  <Dialog open={open} onClose={onClose} aria-label={title} className="max-w-3xl">
    <div className="max-h-[85vh] overflow-y-auto p-6">
      <SectionHeading level={2} className="pr-10">
        {title}
      </SectionHeading>
      {children}
    </div>
  </Dialog>
);

export const DiscoveryDefinitionList: React.FC<DiscoveryDefinitionListProps> = ({
  definitions,
  loading,
  error,
  forbiddenReason,
  onRetry,
  onCreateDefinition,
  onUpdateDefinition,
  onDeleteDefinition,
  onRunDefinition,
  onToggleSchedule,
}) => {
  const canWrite = usePermission('write');
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

  const columns: Array<Column<DiscoveryDefinition>> = [
    {
      header: 'Name',
      render: (definition) => (
        <div>
          <span className="text-sm font-medium">{definition.name}</span>
          {definition.description && (
            <p className="mt-0.5 max-w-[300px] truncate text-xs text-[var(--hh-text-muted)]">
              {definition.description}
            </p>
          )}
        </div>
      ),
    },
    {
      header: 'Provider',
      render: (definition) => <Badge variant="neutral">{definition.provider.toUpperCase()}</Badge>,
    },
    {
      header: 'Status',
      render: (definition) => (
        <Badge variant={definition.active ? 'success' : 'neutral'}>
          {definition.active ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
    {
      header: 'Schedule',
      render: (definition) => (
        <div className="flex items-center gap-2">
          {/* POST .../schedule/enable|disable need 'write' (discovery-definition.routes.ts); a viewer sees the state, not a toggle. */}
          {canWrite ? (
            <Switch
              aria-label={`Schedule for ${definition.name}`}
              checked={definition.schedule?.enabled || false}
              onChange={(checked) => onToggleSchedule(definition.id, checked)}
            />
          ) : (
            <Badge variant={definition.schedule?.enabled ? 'success' : 'neutral'}>
              {definition.schedule?.enabled ? 'Scheduled' : 'Not running'}
            </Badge>
          )}
          <span className="text-sm">{getCronDescription(definition.schedule?.cronExpression)}</span>
        </div>
      ),
    },
    {
      header: 'Last Run',
      render: (definition) => (
        <div>
          <span className="text-sm text-[var(--hh-text-muted)]">{formatDate(definition.lastRunAt)}</span>
          {definition.lastRunStatus && (
            <Badge
              variant={definition.lastRunStatus === 'completed' ? 'neutral' : 'danger'}
              className="ml-2"
            >
              {definition.lastRunStatus}
            </Badge>
          )}
        </div>
      ),
    },
  ];
  if (canWrite) {
    columns.push({
      header: 'Actions',
      className: 'text-right',
      render: (definition) => (
        <div className="flex justify-end gap-1">
          <IconButton
            icon="play"
            variant="ghost"
            size="sm"
            aria-label={`Run ${definition.name}`}
            onClick={() => onRunDefinition(definition.id)}
          />
          <IconButton
            icon="pencil-simple"
            variant="ghost"
            size="sm"
            aria-label={`Edit ${definition.name}`}
            onClick={() => handleEdit(definition)}
          />
          <IconButton
            icon="trash"
            variant="ghost"
            size="sm"
            aria-label={`Delete ${definition.name}`}
            onClick={() => setDeletingDefinition(definition)}
          />
        </div>
      ),
    });
  }

  const createButton = (
    <Button icon="plus" size="md" onClick={() => setShowCreateDialog(true)}>
      Create Definition
    </Button>
  );

  const renderBody = () => {
    if (error && forbiddenReason) {
      return (
        <EmptyState
          tone="danger"
          icon="lock-key"
          title="Not permitted"
          description={forbiddenReason}
        />
      );
    }
    if (error && definitions.length === 0) {
      return (
        <EmptyState
          tone="danger"
          icon="warning-circle"
          title="Could not load discovery definitions"
          description={error}
          action={
            onRetry ? (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                Try again
              </Button>
            ) : undefined
          }
        />
      );
    }
    if (!loading && !error && definitions.length === 0) {
      return (
        <EmptyState
          icon="magnifying-glass"
          title="No discovery definitions"
          description={
            canWrite
              ? 'No discovery definitions found. Create your first definition to get started.'
              : 'No discovery definitions found.'
          }
        />
      );
    }
    return (
      <>
        {error && (
          <Banner tone="danger" icon="warning-circle">
            {error}
            {onRetry && (
              <Button size="sm" variant="secondary" className="ml-3" onClick={onRetry}>
                Try again
              </Button>
            )}
          </Banner>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <Input
            aria-label="Search definitions"
            icon="magnifying-glass"
            type="text"
            placeholder="Search definitions..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            containerClassName="min-w-[250px] flex-1"
          />
          <Select
            aria-label="Filter by provider"
            value={filterProvider}
            onChange={(value) => setFilterProvider(value as DiscoveryProvider | 'all')}
            options={PROVIDER_FILTER_OPTIONS}
            containerClassName="min-w-[170px]"
          />
          <Select
            aria-label="Filter by status"
            value={filterActive}
            onChange={(value) => setFilterActive(value as 'all' | 'active' | 'inactive')}
            options={STATUS_FILTER_OPTIONS}
            containerClassName="min-w-[150px]"
          />
        </div>
        <DataTable
          caption="Discovery definitions"
          rows={filteredDefinitions}
          columns={columns}
          rowKey={(definition) => definition.id}
          loading={loading}
          emptyLabel="No definitions match the current filters."
          // No count until there is something to count: a pending first load is not "0 of 0".
          footer={
            loading && definitions.length === 0 ? undefined : (
              <span className="text-sm">
                {filteredDefinitions.length} of {definitions.length} definitions
              </span>
            )
          }
        />
      </>
    );
  };

  return (
    <div className="space-y-6">
      <SectionHeading
        right={
          <RequirePermission permission="write">
            {createButton}
          </RequirePermission>
        }
      >
        Discovery Definitions
      </SectionHeading>
      <p className="-mt-4 text-sm text-[var(--hh-text-muted)]">
        Manage reusable discovery configurations
      </p>

      {renderBody()}

      <FormModal
        open={showCreateDialog}
        title="Create Discovery Definition"
        onClose={() => setShowCreateDialog(false)}
      >
        <DiscoveryDefinitionForm
          onSubmit={handleCreate}
          onCancel={() => setShowCreateDialog(false)}
        />
      </FormModal>

      <FormModal
        open={!!editingDefinition}
        title="Edit Discovery Definition"
        onClose={() => setEditingDefinition(null)}
      >
        {editingDefinition && (
          <DiscoveryDefinitionForm
            definition={editingDefinition}
            onSubmit={handleUpdate}
            onCancel={() => setEditingDefinition(null)}
          />
        )}
      </FormModal>

      <ConfirmDialog
        open={!!deletingDefinition}
        tone="danger"
        title="Delete Definition"
        body={`Are you sure you want to delete "${deletingDefinition?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeletingDefinition(null)}
      />
    </div>
  );
};

export default DiscoveryDefinitionList;
