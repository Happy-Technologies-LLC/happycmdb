// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import {
  Badge,
  Card,
  DataTable,
  Icon,
  IconButton,
  Input,
  Select,
  type BadgeVariant,
  type Column,
} from '@happy-technologies/design-system';
import { useDiscoverySessions } from '@/hooks/useDiscoverySessions';
import { AIDiscoverySession } from '@/services/ai-pattern.service';
import { QueryState } from '@/components/estate/SurfaceState';
import { EMPTY_VALUE, NOT_AVAILABLE, isKnown } from '@/lib/dashboardValue';
import { SessionDetailModal } from './SessionDetailModal';
import { readFailure, useReadRefusal } from './readState';

const STATUS_OPTIONS = [
  { value: 'all', label: 'All Statuses' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'running', label: 'Running' },
];

const STATUS_BADGES: Record<string, { variant: BadgeVariant; label: string; icon: string; spin?: boolean }> = {
  completed: { variant: 'success', label: 'Completed', icon: 'check-circle' },
  failed: { variant: 'danger', label: 'Failed', icon: 'x-circle' },
  running: { variant: 'info', label: 'Running', icon: 'clock', spin: true },
};

export const DiscoverySessionsView: React.FC = () => {
  const { sessions, loading, error, loadSessions } = useDiscoverySessions();
  const refusal = useReadRefusal();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [modelFilter, setModelFilter] = useState<string>('all');
  const [selectedSession, setSelectedSession] = useState<AIDiscoverySession | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);

  if (loading) {
    return <QueryState what="discovery sessions" loading />;
  }

  if (error || refusal !== null) {
    return (
      <QueryState
        what="discovery sessions"
        error={readFailure(error, refusal)}
        onRetry={() => void loadSessions()}
      />
    );
  }

  // Get unique AI models actually seen on these sessions
  const aiModels = Array.from(new Set(sessions.map(s => s.aiModel)));
  const modelOptions = [{ value: 'all', label: 'All Models' }, ...aiModels.map(model => ({ value: model, label: model }))];

  // Filter sessions
  const filteredSessions = sessions.filter(session => {
    const matchesSearch = !searchTerm ||
      session.targetHost.toLowerCase().includes(searchTerm.toLowerCase()) ||
      session.sessionId.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = statusFilter === 'all' || session.status === statusFilter;
    const matchesModel = modelFilter === 'all' || session.aiModel === modelFilter;

    return matchesSearch && matchesStatus && matchesModel;
  });

  const getStatusBadge = (status: string) => {
    const config = STATUS_BADGES[status] || STATUS_BADGES.running;

    return (
      <Badge variant={config.variant}>
        <Icon name={config.icon} size={12} className={config.spin ? 'animate-spin' : undefined} />
        {config.label}
      </Badge>
    );
  };

  const handleViewDetails = (session: AIDiscoverySession) => {
    setSelectedSession(session);
    setDetailModalOpen(true);
  };

  const columns: Array<Column<AIDiscoverySession>> = [
    {
      header: 'Target',
      render: (session) => (
        <div className="flex flex-col">
          <span className="hh-mono text-sm font-medium">{session.targetHost}</span>
          <span className="text-xs text-[var(--hh-text-muted)]">:{session.targetPort}</span>
        </div>
      ),
    },
    { header: 'Status', render: (session) => getStatusBadge(session.status) },
    {
      header: 'Model',
      render: (session) => (
        <div className="flex items-center gap-2">
          <Icon name="brain" size={16} />
          <span className="text-sm">{session.aiModel}</span>
        </div>
      ),
    },
    {
      header: 'Confidence',
      className: 'text-right',
      render: (session) =>
        isKnown(session.confidenceScore) ? (
          <Badge variant={session.confidenceScore >= 0.8 ? 'success' : 'default'}>
            {(session.confidenceScore * 100).toFixed(0)}%
          </Badge>
        ) : (
          NOT_AVAILABLE
        ),
    },
    {
      header: 'CIs Found',
      className: 'text-right',
      // Not reported is not 0 CIs (the detail modal shows the same dash)
      render: (session) => (session.discoveredCIs ? session.discoveredCIs.length : EMPTY_VALUE),
    },
    {
      header: 'Cost',
      className: 'text-right',
      // An unknown cost is not $0.0000
      render: (session) =>
        isKnown(session.estimatedCost) ? (
          <span className={session.estimatedCost > 0 ? 'text-[var(--hh-warning-text)]' : 'text-[var(--hh-success-text)]'}>
            ${session.estimatedCost.toFixed(4)}
          </span>
        ) : (
          NOT_AVAILABLE
        ),
    },
    {
      header: 'Duration',
      className: 'text-right',
      render: (session) => (session.durationMs ? `${(session.durationMs / 1000).toFixed(1)}s` : '-'),
    },
    {
      header: 'Started',
      render: (session) => <span className="text-sm">{new Date(session.startedAt).toLocaleString()}</span>,
    },
    {
      header: 'Actions',
      className: 'text-right',
      render: (session) => (
        <IconButton
          icon="eye"
          variant="ghost"
          size="sm"
          onClick={() => handleViewDetails(session)}
          title="View Details"
          aria-label="View Details"
        />
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Filters */}
      <Card inset="none" className="flex flex-col gap-4 p-4 md:flex-row">
        <Input
          icon="magnifying-glass"
          size="sm"
          aria-label="Search sessions"
          placeholder="Search by host or session ID..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          containerClassName="flex-1"
        />
        <Select
          size="sm"
          aria-label="Filter by status"
          value={statusFilter}
          onChange={setStatusFilter}
          options={STATUS_OPTIONS}
          containerClassName="w-full md:w-[180px]"
        />
        <Select
          size="sm"
          aria-label="Filter by model"
          value={modelFilter}
          onChange={setModelFilter}
          options={modelOptions}
          containerClassName="w-full md:w-[180px]"
        />
      </Card>

      {/* Sessions Table */}
      <DataTable
        caption="Discovery sessions"
        rows={filteredSessions}
        columns={columns}
        rowKey={(session) => session.sessionId}
        onRowClick={handleViewDetails}
        emptyLabel="No discovery sessions found"
      />

      {/* Session Detail Modal */}
      {selectedSession && (
        <SessionDetailModal
          session={selectedSession}
          open={detailModalOpen}
          onClose={() => setDetailModalOpen(false)}
        />
      )}
    </div>
  );
};
