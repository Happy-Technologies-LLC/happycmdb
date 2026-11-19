// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { DiscoveryDefinition, DiscoveryProvider } from '../../services/discovery.service';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Icon,
  IconButton,
  IconWell,
  Separator,
  Switch,
  type IconWellTone,
} from '@happy-technologies/design-system';
import { RequirePermission } from '@/components/common/RequirePermission';
import { usePermission } from '@/hooks/usePermission';
import { useToast } from '../../contexts/ToastContext';

interface DiscoveryDefinitionCardProps {
  definition: DiscoveryDefinition;
  onRun: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleSchedule: (id: string, enabled: boolean) => void;
}

const PROVIDER_CONFIG: Record<
  DiscoveryProvider,
  { name: string; tone: IconWellTone; icon: string }
> = {
  nmap: { name: 'Network Scan (Nmap)', tone: 'accent', icon: 'share-network' },
  ssh: { name: 'SSH Discovery', tone: 'success', icon: 'hard-drive' },
  'active-directory': { name: 'Active Directory', tone: 'ai', icon: 'users' },
  snmp: { name: 'SNMP Discovery', tone: 'danger', icon: 'share-network' },
};

const formatRelativeTime = (dateString?: string): string => {
  if (!dateString) return 'Never';
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
};

const parseCronExpression = (cron?: string): string => {
  if (!cron) return 'Not configured';

  // Basic cron pattern recognition
  const patterns: Record<string, string> = {
    '0 0 * * *': 'Daily at midnight',
    '0 2 * * *': 'Daily at 2 AM',
    '0 0 * * 0': 'Weekly on Sunday',
    '0 0 1 * *': 'Monthly on 1st',
    '0 */6 * * *': 'Every 6 hours',
    '0 */12 * * *': 'Every 12 hours',
    '*/15 * * * *': 'Every 15 minutes',
    '*/30 * * * *': 'Every 30 minutes',
  };

  return patterns[cron] || cron;
};

export const DiscoveryDefinitionCard: React.FC<DiscoveryDefinitionCardProps> = ({
  definition,
  onRun,
  onEdit,
  onDelete,
  onToggleSchedule,
}) => {
  const config = PROVIDER_CONFIG[definition.provider];
  const canWrite = usePermission('write');
  const [isScheduleEnabled, setIsScheduleEnabled] = useState(definition.schedule.enabled);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { showToast } = useToast();

  const handleScheduleToggle = async () => {
    const newState = !isScheduleEnabled;
    setIsScheduleEnabled(newState);
    try {
      await onToggleSchedule(definition.id, newState);
      showToast(
        `Discovery schedule for ${definition.name} has been ${newState ? 'enabled' : 'disabled'}.`,
        'success'
      );
    } catch (error) {
      setIsScheduleEnabled(!newState);
      showToast('Failed to toggle schedule', 'error');
    }
  };

  const handleRun = () => {
    onRun(definition.id);
    showToast(`Running discovery for ${definition.name}...`, 'info');
  };

  const getStatusBadge = () => {
    if (!definition.lastRunStatus) {
      return <Badge variant="neutral">Never run</Badge>;
    }

    switch (definition.lastRunStatus) {
      case 'completed':
        return (
          <Badge variant="success">
            <Icon name="check-circle" size={12} />
            Success
          </Badge>
        );
      case 'failed':
        return (
          <Badge variant="danger">
            <Icon name="warning-circle" size={12} />
            Failed
          </Badge>
        );
      case 'running':
        return (
          <Badge variant="info">
            <Icon name="clock" size={12} className="animate-spin" />
            Running
          </Badge>
        );
      default:
        return <Badge variant="neutral">{definition.lastRunStatus}</Badge>;
    }
  };

  return (
    <Card as="article" className={`flex h-full flex-col gap-4 ${definition.active ? '' : 'opacity-70'}`}>
      <div>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <IconWell icon={config.icon} tone={config.tone} size="lg" />
            <div>
              <p className="font-semibold">{definition.name}</p>
              <p className="text-xs text-[var(--hh-text-muted)]">{config.name}</p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Badge variant={definition.active ? 'success' : 'neutral'}>
              {definition.active ? 'Active' : 'Inactive'}
            </Badge>
            {getStatusBadge()}
          </div>
        </div>
        {definition.description && (
          <p className="mt-2 text-sm text-[var(--hh-text-muted)]">{definition.description}</p>
        )}
      </div>

      <div className="flex-1 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-[var(--hh-text-muted)]">
            <Icon name="calendar" size={16} />
            <span>Schedule:</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">
              {parseCronExpression(definition.schedule.cronExpression)}
            </span>
            {/* POST .../schedule/enable|disable need 'write' (discovery-definition.routes.ts); a viewer sees the state, not a toggle. */}
            {canWrite ? (
              <Switch
                aria-label={`Schedule for ${definition.name}`}
                checked={isScheduleEnabled}
                onChange={handleScheduleToggle}
                disabled={!definition.active || !definition.schedule.cronExpression}
              />
            ) : (
              <Badge variant={isScheduleEnabled ? 'success' : 'neutral'}>
                {isScheduleEnabled ? 'Scheduled' : 'Not running'}
              </Badge>
            )}
          </div>
        </div>

        <Separator />

        <div className="space-y-2">
          <div className="flex justify-between">
            <span className="text-sm text-[var(--hh-text-muted)]">Last Run:</span>
            <span className="text-sm font-medium">{formatRelativeTime(definition.lastRunAt)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-[var(--hh-text-muted)]">Created:</span>
            <span className="text-sm font-medium">{formatRelativeTime(definition.createdAt)}</span>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <RequirePermission permission="write">
          <Button
            className="flex-1"
            icon="play"
            size="md"
            onClick={handleRun}
            disabled={!definition.active}
          >
            Run Now
          </Button>
          <IconButton
            icon="pencil-simple"
            variant="outline"
            shape="rounded"
            aria-label={`Edit ${definition.name}`}
            onClick={() => onEdit(definition.id)}
          />
          <IconButton
            icon="trash"
            variant="outline"
            shape="rounded"
            aria-label={`Delete ${definition.name}`}
            onClick={() => setConfirmingDelete(true)}
          />
          <ConfirmDialog
            open={confirmingDelete}
            tone="danger"
            title="Delete Discovery Definition"
            body={`Are you sure you want to delete "${definition.name}"? This action cannot be undone. Any scheduled jobs will be cancelled.`}
            confirmLabel="Delete"
            onConfirm={() => {
              setConfirmingDelete(false);
              onDelete(definition.id);
            }}
            onCancel={() => setConfirmingDelete(false)}
          />
        </RequirePermission>
      </div>
    </Card>
  );
};

export default DiscoveryDefinitionCard;
