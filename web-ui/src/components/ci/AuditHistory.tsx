// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useMemo } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { useCIAuditHistory } from '../../hooks/useCIs';
import { AuditLogEntry, AuditChange } from '../../services/ci.service';
import { Badge } from '../ui/badge';
import { cn } from '../../utils/cn';

interface AuditHistoryProps {
  ciId: string;
}

const ACTION_COLORS = {
  CREATE: 'success',
  UPDATE: 'info',
  DELETE: 'destructive',
  RELATIONSHIP_ADD: 'success',
  RELATIONSHIP_REMOVE: 'warning',
  DISCOVERY_UPDATE: 'secondary',
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
  const { data: auditLogs, isLoading, error } = useCIAuditHistory(ciId);
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
        className="border border-border/30 rounded-lg p-3 bg-muted/20 hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
              {change.field.replace(/_/g, ' ')}
            </p>
            <div className="space-y-2">
              <div className="flex items-start gap-2">
                <span className="text-xs text-muted-foreground shrink-0 mt-1">From:</span>
                <code
                  className={cn(
                    'text-xs bg-destructive/10 text-destructive px-2 py-1 rounded flex-1',
                    isLongValue && !isExpanded && 'truncate'
                  )}
                >
                  {oldValueStr}
                </code>
              </div>
              <div className="flex items-center justify-center">
                <Icon name="arrow-right" size={12} className="text-muted-foreground" />
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs text-muted-foreground shrink-0 mt-1">To:</span>
                <code
                  className={cn(
                    'text-xs bg-success-soft text-success px-2 py-1 rounded flex-1',
                    isLongValue && !isExpanded && 'truncate'
                  )}
                >
                  {newValueStr}
                </code>
              </div>
            </div>
          </div>
          {isLongValue && (
            <button
              onClick={() => toggleExpanded(`change-${index}`)}
              className="p-1 hover:bg-muted rounded transition-colors shrink-0"
              title={isExpanded ? 'Collapse' : 'Expand'}
            >
              {isExpanded ? (
                <Icon name="caret-up" size={16} className="text-muted-foreground" />
              ) : (
                <Icon name="caret-down" size={16} className="text-muted-foreground" />
              )}
            </button>
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
      <div
        key={entry.id}
        className="border border-border/30 rounded-lg p-4 hover:border-primary/30 transition-colors"
      >
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex items-start gap-3 flex-1">
            <div className="p-2 bg-primary/10 rounded-lg shrink-0">
              <Icon name={actorIconName} size={16} className="text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <Badge variant={ACTION_COLORS[entry.action] as any}>
                  {ACTION_LABELS[entry.action]}
                </Badge>
                <span className="text-sm text-foreground font-medium">{entry.actor}</span>
                <span className="text-xs text-muted-foreground">
                  ({entry.actor_type})
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Icon name="clock" size={12} />
                <span title={formatFullTimestamp(entry.timestamp)}>
                  {formatTimestamp(entry.timestamp)}
                </span>
                <span className="text-muted-foreground/50">•</span>
                <span>{formatFullTimestamp(entry.timestamp)}</span>
              </div>
              {entry.ip_address && (
                <div className="text-xs text-muted-foreground mt-1">
                  IP: {entry.ip_address}
                </div>
              )}
            </div>
          </div>
          {hasChanges && (
            <button
              onClick={() => toggleExpanded(entry.id)}
              className="p-2 hover:bg-muted rounded-lg transition-colors shrink-0"
              title={isExpanded ? 'Collapse changes' : 'Expand changes'}
            >
              {isExpanded ? (
                <Icon name="caret-up" size={20} className="text-muted-foreground" />
              ) : (
                <Icon name="caret-down" size={20} className="text-muted-foreground" />
              )}
            </button>
          )}
        </div>

        {hasChanges && isExpanded && (
          <div className="mt-4 space-y-2 pl-11">
            <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider mb-2">
              Changes ({entry.changes.length})
            </h4>
            <div className="space-y-2">
              {entry.changes.map((change, index) => renderChange(change, index))}
            </div>
          </div>
        )}

        {entry.metadata && Object.keys(entry.metadata).length > 0 && isExpanded && (
          <div className="mt-4 pl-11">
            <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider mb-2">
              Metadata
            </h4>
            <div className="bg-muted/30 border border-border/30 rounded p-2">
              <pre className="text-xs text-foreground overflow-x-auto">
                {JSON.stringify(entry.metadata, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </div>
    );
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4 text-destructive">
        Failed to load audit history. Please try again later.
      </div>
    );
  }

  if (!auditLogs || auditLogs.length === 0) {
    return (
      <div className="bg-primary/10 border border-primary/20 rounded-lg p-8 text-center">
        <Icon name="clock" size={48} className="text-primary mx-auto mb-3 opacity-50" />
        <p className="text-primary text-lg font-medium">No audit history available</p>
        <p className="text-muted-foreground text-sm mt-1">
          Changes to this CI will appear here once they occur.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center justify-between bg-muted/30 border border-border/30 rounded-lg p-4">
        <div className="flex items-center gap-2">
          <Icon name="funnel" size={16} className="text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Filters:</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Action Type Filter */}
          <select
            value={selectedAction}
            onChange={(e) => setSelectedAction(e.target.value)}
            className="px-3 py-1.5 text-sm border border-input rounded-lg bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="all">All Actions</option>
            {uniqueActions.map((action) => (
              <option key={action} value={action}>
                {ACTION_LABELS[action as keyof typeof ACTION_LABELS]}
              </option>
            ))}
          </select>

          {/* Date Range Filter */}
          <div className="flex items-center gap-1 border border-input rounded-lg bg-background overflow-hidden">
            <Icon name="calendar" size={16} className="text-muted-foreground ml-2" />
            <select
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value as any)}
              className="px-2 py-1.5 text-sm bg-transparent text-foreground focus:outline-none border-0"
            >
              <option value="all">All Time</option>
              <option value="24h">Last 24 Hours</option>
              <option value="7d">Last 7 Days</option>
              <option value="30d">Last 30 Days</option>
            </select>
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          Showing {filteredLogs.length} of {auditLogs.length} entries
        </div>
      </div>

      {/* Timeline */}
      <div className="space-y-3">
        {filteredLogs.length === 0 ? (
          <div className="bg-muted/30 border border-border/30 rounded-lg p-8 text-center">
            <p className="text-muted-foreground">
              No audit entries match the selected filters.
            </p>
          </div>
        ) : (
          filteredLogs.map((entry) => renderAuditEntry(entry))
        )}
      </div>
    </div>
  );
};

export default AuditHistory;
