// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useMemo } from 'react';
import {
  Badge,
  Card,
  EmptyState,
  Icon,
  IconButton,
  JsonBlock,
  NativeSelect,
} from '@happy-technologies/design-system';
import { useCIAuditHistory } from '../../hooks/useCIs';
import { AuditLogEntry, AuditChange } from '../../services/ci.service';
import { QueryState } from '../estate/SurfaceState';
import { cn } from '../../utils/cn';

interface AuditHistoryProps {
  ciId: string;
}

const ACTION_COLORS = {
  CREATE: 'success',
  UPDATE: 'info',
  DELETE: 'danger',
  RELATIONSHIP_ADD: 'success',
  RELATIONSHIP_REMOVE: 'warning',
  DISCOVERY_UPDATE: 'neutral',
} as const;

const ACTION_LABELS = {
  CREATE: 'Created',
  UPDATE: 'Updated',
  DELETE: 'Deleted',
  RELATIONSHIP_ADD: 'Relationship Added',
  RELATIONSHIP_REMOVE: 'Relationship Removed',
  DISCOVERY_UPDATE: 'Discovery Update',
};

const ACTOR_TYPE_ICONS = {
  user: 'user',
  system: 'robot',
  discovery: 'magnifying-glass',
};

export const AuditHistory: React.FC<AuditHistoryProps> = ({ ciId }) => {
  const { data: auditLogs, isLoading, error, refetch } = useCIAuditHistory(ciId);
  const [selectedAction, setSelectedAction] = useState<string>('all');
  const [dateRange, setDateRange] = useState<'all' | '24h' | '7d' | '30d'>('all');
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());

  const filteredLogs = useMemo(() => {
    if (!auditLogs) return [];

    let filtered = [...auditLogs];

    // Filter by action type
    if (selectedAction !== 'all') {
      filtered = filtered.filter((log) => log.action === selectedAction);
    }

    // Filter by date range
    if (dateRange !== 'all') {
      const now = Date.now();
      const ranges = {
        '24h': 24 * 60 * 60 * 1000,
        '7d': 7 * 24 * 60 * 60 * 1000,
        '30d': 30 * 24 * 60 * 60 * 1000,
      };
      const cutoff = now - ranges[dateRange];
      filtered = filtered.filter((log) => new Date(log.timestamp).getTime() >= cutoff);
    }

    return filtered;
  }, [auditLogs, selectedAction, dateRange]);

  const uniqueActions = useMemo(() => {
    if (!auditLogs) return [];
    const actions = new Set(auditLogs.map((log) => log.action));
    return Array.from(actions);
  }, [auditLogs]);

  const toggleExpanded = (entryId: string) => {
    const newExpanded = new Set(expandedEntries);
    if (newExpanded.has(entryId)) {
      newExpanded.delete(entryId);
    } else {
      newExpanded.add(entryId);
    }
    setExpandedEntries(newExpanded);
  };

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days} day${days > 1 ? 's' : ''} ago`;
    }
    if (hours > 0) {
      return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    }
    if (minutes > 0) {
      return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    }
    return 'Just now';
  };

  const formatFullTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatValue = (value: any): string => {
    if (value === null || value === undefined) return 'N/A';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
  };

  const renderChange = (change: AuditChange, index: number) => {
    const isExpanded = expandedEntries.has(`change-${index}`);
    const oldValueStr = formatValue(change.old_value);
    const newValueStr = formatValue(change.new_value);
    const isLongValue = oldValueStr.length > 50 || newValueStr.length > 50;

    return (
      <div
        key={index}
        className="rounded-lg p-3 bg-[var(--hh-bg-elevated)]"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="hh-heading text-[length:var(--hh-text-2xs)] text-[var(--hh-text-muted)] mb-2">
              {change.field.replace(/_/g, ' ')}
            </p>
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <span className="text-xs text-[var(--hh-text-muted)] shrink-0 mt-1">From:</span>
                <code
                  className={cn(
                    'text-xs bg-[var(--hh-error-bg)] text-[var(--hh-error-text)] px-2 py-1 rounded flex-1',
                    isLongValue && !isExpanded && 'truncate'
                  )}
                >
                  {oldValueStr}
                </code>
              </div>
              <div className="flex items-center justify-center">
                <Icon name="arrow-right" size={12} className="text-[var(--hh-text-muted)]" />
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs text-[var(--hh-text-muted)] shrink-0 mt-1">To:</span>
                <code
                  className={cn(
                    'text-xs bg-[var(--hh-success-bg)] text-[var(--hh-success-text)] px-2 py-1 rounded flex-1',
                    isLongValue && !isExpanded && 'truncate'
                  )}
                >
                  {newValueStr}
                </code>
              </div>
            </div>
          </div>
          {isLongValue && (
            <IconButton
              icon={isExpanded ? 'caret-up' : 'caret-down'}
              variant="ghost"
              size="sm"
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
              aria-expanded={isExpanded}
              onClick={() => toggleExpanded(`change-${index}`)}
            />
          )}
        </div>
      </div>
    );
  };

  const renderAuditEntry = (entry: AuditLogEntry) => {
    const actorIconName = ACTOR_TYPE_ICONS[entry.actor_type] || 'user';
    const isExpanded = expandedEntries.has(entry.id);
    const hasChanges = entry.changes && entry.changes.length > 0;

    return (
      <Card as="article" key={entry.id} inset="none" className="p-4">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex items-start gap-3 flex-1">
            <div className="p-2 bg-[var(--hh-accent-bg)] rounded-lg shrink-0">
              <Icon name={actorIconName} size={16} className="text-[var(--hh-accent-text)]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <Badge variant={ACTION_COLORS[entry.action]}>
                  {ACTION_LABELS[entry.action]}
                </Badge>
                <span className="text-sm text-[var(--hh-text-primary)] font-medium">{entry.actor}</span>
                <span className="text-xs text-[var(--hh-text-muted)]">
                  ({entry.actor_type})
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-[var(--hh-text-muted)]">
                <Icon name="clock" size={12} />
                <span title={formatFullTimestamp(entry.timestamp)}>
                  {formatTimestamp(entry.timestamp)}
                </span>
                <span aria-hidden="true">•</span>
                <span>{formatFullTimestamp(entry.timestamp)}</span>
              </div>
              {entry.ip_address && (
                <div className="text-xs text-[var(--hh-text-muted)] mt-1">
                  IP: {entry.ip_address}
                </div>
              )}
            </div>
          </div>
          {hasChanges && (
            <IconButton
              icon={isExpanded ? 'caret-up' : 'caret-down'}
              variant="ghost"
              aria-label={isExpanded ? 'Collapse changes' : 'Expand changes'}
              aria-expanded={isExpanded}
              onClick={() => toggleExpanded(entry.id)}
            />
          )}
        </div>

        {hasChanges && isExpanded && (
          <div className="mt-4 space-y-2 pl-11">
            <h4 className="hh-heading text-[length:var(--hh-text-2xs)] text-[var(--hh-text-muted)] mb-2">
              Changes ({entry.changes.length})
            </h4>
            <div className="space-y-2">
              {entry.changes.map((change, index) => renderChange(change, index))}
            </div>
          </div>
        )}

        {entry.metadata && Object.keys(entry.metadata).length > 0 && isExpanded && (
          <JsonBlock className="mt-4 pl-11" label="Metadata" value={entry.metadata} />
        )}
      </Card>
    );
  };

  if (isLoading) {
    return <QueryState what="audit history" loading />;
  }

  if (error) {
    return <QueryState what="audit history" error={error} onRetry={() => void refetch()} />;
  }

  if (!auditLogs || auditLogs.length === 0) {
    return (
      <EmptyState
        icon="clock"
        title="No audit history available"
        description="Changes to this CI will appear here once they occur."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <Card inset="none" className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-2">
          <Icon name="funnel" size={16} className="text-[var(--hh-text-muted)]" />
          <span className="text-sm font-medium text-[var(--hh-text-primary)]">Filters:</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Action Type Filter */}
          <NativeSelect
            size="sm"
            aria-label="Filter by action"
            value={selectedAction}
            onChange={(e) => setSelectedAction(e.target.value)}
          >
            <option value="all">All Actions</option>
            {uniqueActions.map((action) => (
              <option key={action} value={action}>
                {ACTION_LABELS[action as keyof typeof ACTION_LABELS]}
              </option>
            ))}
          </NativeSelect>

          {/* Date Range Filter */}
          <NativeSelect
            size="sm"
            aria-label="Filter by date range"
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as typeof dateRange)}
          >
            <option value="all">All Time</option>
            <option value="24h">Last 24 Hours</option>
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
          </NativeSelect>
        </div>
        <div className="text-sm text-[var(--hh-text-muted)]">
          Showing {filteredLogs.length} of {auditLogs.length} entries
        </div>
      </Card>

      {/* Timeline */}
      <div className="space-y-3">
        {filteredLogs.length === 0 ? (
          <EmptyState label="No audit entries match the selected filters." />
        ) : (
          filteredLogs.map((entry) => renderAuditEntry(entry))
        )}
      </div>
    </div>
  );
};

export default AuditHistory;
