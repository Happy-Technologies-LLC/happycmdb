// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Icon,
  IconButton,
  Input,
  Select,
  type BadgeVariant,
  type Column,
} from '@happy-technologies/design-system';
import { useAIPatterns } from '@/hooks/useAIPatterns';
import { AIPattern } from '@/services/ai-pattern.service';
import { QueryState } from '@/components/estate/SurfaceState';
import { RequirePermission } from '@/components/common/RequirePermission';
import { EMPTY_VALUE, isKnown } from '@/lib/dashboardValue';
import { PatternDetailModal } from './PatternDetailModal';
import { readFailure, useReadRefusal } from './readState';

const STATUS_OPTIONS = [
  { value: 'all', label: 'All Statuses' },
  { value: 'active', label: 'Active' },
  { value: 'approved', label: 'Approved' },
  { value: 'review', label: 'In Review' },
  { value: 'draft', label: 'Draft' },
];

const PAGE_SIZE_OPTIONS = [
  { value: '10', label: '10 / page' },
  { value: '25', label: '25 / page' },
  { value: '50', label: '50 / page' },
  { value: '100', label: '100 / page' },
];

const STATUS_BADGES: Record<string, { variant: BadgeVariant; label: string; icon: string }> = {
  active: { variant: 'success', label: 'Active', icon: 'check-circle' },
  approved: { variant: 'info', label: 'Approved', icon: 'check-circle' },
  review: { variant: 'warning', label: 'In Review', icon: 'clock' },
  draft: { variant: 'neutral', label: 'Draft', icon: 'pencil-simple' },
  deprecated: { variant: 'danger', label: 'Deprecated', icon: 'x-circle' },
};

/** Successful share of uses, in percent; unknown (not 0) while the pattern has never been used. */
const successRateOf = (pattern: AIPattern): number | null =>
  pattern.usageCount > 0 ? (pattern.successCount / pattern.usageCount) * 100 : null;

export const PatternLibrary: React.FC = () => {
  const { patterns, loading, error, loadPatterns, activatePattern, deactivatePattern, approvePattern, deletePattern } =
    useAIPatterns();
  const refusal = useReadRefusal();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [selectedPattern, setSelectedPattern] = useState<AIPattern | null>(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Reset to page 1 when filters change (a hook: it stays above the loading early return)
  React.useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter, categoryFilter]);

  if (loading) {
    return <QueryState what="patterns" loading />;
  }

  if (error || refusal !== null) {
    return (
      <QueryState
        what="patterns"
        error={readFailure(error, refusal)}
        onRetry={() => void loadPatterns()}
      />
    );
  }

  // Get unique categories
  const categories = Array.from(new Set(patterns.map(p => p.category)));
  const categoryOptions = [{ value: 'all', label: 'All Categories' }, ...categories.map(cat => ({ value: cat, label: cat }))];

  // Filter patterns
  const filteredPatterns = patterns.filter(pattern => {
    const matchesSearch = !searchTerm ||
      pattern.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      pattern.category.toLowerCase().includes(searchTerm.toLowerCase()) ||
      pattern.description?.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesStatus = statusFilter === 'all' || pattern.status === statusFilter;
    const matchesCategory = categoryFilter === 'all' || pattern.category === categoryFilter;

    return matchesSearch && matchesStatus && matchesCategory;
  });

  // Pagination
  const totalPages = Math.ceil(filteredPatterns.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedPatterns = filteredPatterns.slice(startIndex, endIndex);

  const getStatusBadge = (status: string) => {
    const config = STATUS_BADGES[status] || STATUS_BADGES.draft;

    return (
      <Badge variant={config.variant}>
        <Icon name={config.icon} size={12} />
        {config.label}
      </Badge>
    );
  };

  const handleActivate = async (pattern: AIPattern) => {
    if (pattern.status === 'approved') {
      await activatePattern(pattern.patternId);
    }
  };

  const handleDeactivate = async (pattern: AIPattern) => {
    if (pattern.isActive) {
      await deactivatePattern(pattern.patternId);
    }
  };

  const handleApprove = async (pattern: AIPattern) => {
    if (pattern.status === 'review') {
      await approvePattern(pattern.patternId);
    }
  };

  const handleDelete = async (pattern: AIPattern) => {
    if (confirm(`Are you sure you want to delete pattern "${pattern.name}"?`)) {
      await deletePattern(pattern.patternId);
    }
  };

  const handleViewDetails = (pattern: AIPattern) => {
    setSelectedPattern(pattern);
    setDetailModalOpen(true);
  };

  // Icon-only row action: the title and the accessible name are the same label.
  const rowAction = (icon: string, label: string, onClick: () => void) => (
    <IconButton icon={icon} variant="ghost" size="sm" onClick={onClick} title={label} aria-label={label} />
  );

  const columns: Array<Column<AIPattern>> = [
    {
      header: 'Name',
      className: 'font-medium',
      render: (pattern) => (
        <div className="flex items-center gap-2">
          {pattern.isActive && <Icon name="sparkle" size={16} className="text-[var(--hh-warning-text)]" />}
          {pattern.name}
        </div>
      ),
    },
    { header: 'Category', render: (pattern) => <Badge variant="neutral">{pattern.category}</Badge> },
    { header: 'Status', render: (pattern) => getStatusBadge(pattern.status) },
    {
      header: 'Confidence',
      className: 'text-right',
      render: (pattern) =>
        isKnown(pattern.confidenceScore) ? (
          <Badge variant={pattern.confidenceScore >= 0.9 ? 'success' : 'default'}>
            {(pattern.confidenceScore * 100).toFixed(0)}%
          </Badge>
        ) : (
          EMPTY_VALUE
        ),
    },
    { header: 'Usage', className: 'text-right', render: (pattern) => pattern.usageCount },
    {
      header: 'Success Rate',
      className: 'text-right',
      render: (pattern) => {
        const successRate = successRateOf(pattern);
        if (successRate === null) return EMPTY_VALUE;
        return (
          <span className={successRate >= 80 ? 'text-[var(--hh-success-text)]' : 'text-[var(--hh-warning-text)]'}>
            {successRate.toFixed(0)}%
          </span>
        );
      },
    },
    {
      header: 'Avg Time',
      className: 'text-right',
      render: (pattern) => (isKnown(pattern.avgExecutionTimeMs) ? `${pattern.avgExecutionTimeMs}ms` : EMPTY_VALUE),
    },
    {
      header: 'Actions',
      className: 'text-right',
      render: (pattern) => (
        <div className="flex justify-end gap-1">
          {pattern.status === 'review' && (
            <RequirePermission permission="admin">
              {rowAction('check-circle', 'Approve', () => handleApprove(pattern))}
            </RequirePermission>
          )}
          {pattern.status === 'approved' && !pattern.isActive && (
            <RequirePermission permission="admin">
              {rowAction('play', 'Activate', () => handleActivate(pattern))}
            </RequirePermission>
          )}
          {pattern.isActive && (
            <RequirePermission permission="write">
              {rowAction('pause', 'Deactivate', () => handleDeactivate(pattern))}
            </RequirePermission>
          )}
          {rowAction('eye', 'View Details', () => handleViewDetails(pattern))}
          {pattern.status === 'draft' && (
            <RequirePermission permission="write">
              {rowAction('trash', 'Delete', () => handleDelete(pattern))}
            </RequirePermission>
          )}
        </div>
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
          aria-label="Search patterns"
          placeholder="Search patterns..."
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
          aria-label="Filter by category"
          value={categoryFilter}
          onChange={setCategoryFilter}
          options={categoryOptions}
          containerClassName="w-full md:w-[200px]"
        />
      </Card>

      {/* Patterns Table, with the pagination controls in its footer */}
      <DataTable
        caption="Patterns"
        rows={paginatedPatterns}
        columns={columns}
        rowKey={(pattern) => pattern.patternId}
        onRowClick={handleViewDetails}
        emptyLabel="No patterns found"
        footer={
          filteredPatterns.length > 0 ? (
            <div className="flex flex-col items-center justify-between gap-4 py-1 md:flex-row">
              <div className="text-sm text-[var(--hh-text-muted)]">
                Showing {startIndex + 1}-{Math.min(endIndex, filteredPatterns.length)} of {filteredPatterns.length} patterns
              </div>

              <div className="flex items-center gap-2">
                <Select
                  size="sm"
                  aria-label="Patterns per page"
                  value={String(pageSize)}
                  onChange={(val) => {
                    setPageSize(Number(val));
                    setCurrentPage(1);
                  }}
                  options={PAGE_SIZE_OPTIONS}
                  containerClassName="w-[120px]"
                />

                <div className="flex items-center gap-1">
                  <Button variant="secondary" size="sm" onClick={() => setCurrentPage(1)} disabled={currentPage === 1}>
                    First
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))} disabled={currentPage === 1}>
                    Previous
                  </Button>

                  <div className="px-3 text-sm">
                    Page {currentPage} of {totalPages}
                  </div>

                  <Button variant="secondary" size="sm" onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))} disabled={currentPage === totalPages}>
                    Next
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages}>
                    Last
                  </Button>
                </div>
              </div>
            </div>
          ) : undefined
        }
      />

      {/* Pattern Detail Modal */}
      {selectedPattern && (
        <PatternDetailModal
          pattern={selectedPattern}
          open={detailModalOpen}
          onClose={() => setDetailModalOpen(false)}
        />
      )}
    </div>
  );
};
