// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { useNavigate } from 'react-router-dom';
import { useCIs } from '../../hooks/useCIs';
import { CI, CIType, CIStatus, Environment } from '../../services/ci.service';
import CIStatusBadge from './CIStatusBadge';
import CITypeBadge, { typeIcons } from './CITypeBadge';
import { cn } from '../../utils/cn';
import { LiquidGlass } from '../ui/liquid-glass';
import { healthColor } from '../../lib/brandColors';
import SearchBar from '../common/SearchBar';
import DataTable from '../common/DataTable';
import type { DataTableColumn, SortOptions } from '../../types';

interface CIListProps {
  onEdit?: (ci: CI) => void;
  onDelete?: (ci: CI) => void;
  onView?: (ci: CI) => void;
  showActions?: boolean;
  initialTypeFilter?: CIType | '';
  initialStatusFilter?: CIStatus | '';
  initialEnvironmentFilter?: Environment | '';
  initialSearch?: string;
}

const CI_TYPES: CIType[] = [
  'server',
  'virtual-machine',
  'container',
  'application',
  'service',
  'database',
  'network-device',
  'storage',
  'load-balancer',
  'cloud-resource',
];

const CI_STATUSES: CIStatus[] = ['active', 'inactive', 'maintenance', 'decommissioned'];

const ENVIRONMENTS: Environment[] = ['production', 'staging', 'development', 'test'];

export const CIList: React.FC<CIListProps> = ({
  onEdit,
  onDelete,
  onView,
  showActions = true,
  initialTypeFilter = '',
  initialStatusFilter = '',
  initialEnvironmentFilter = '',
  initialSearch = '',
}) => {
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [search, setSearch] = useState(initialSearch);
  const [typeFilter, setTypeFilter] = useState<CIType | ''>(initialTypeFilter);
  const [statusFilter, setStatusFilter] = useState<CIStatus | ''>(initialStatusFilter);
  const [environmentFilter, setEnvironmentFilter] = useState<Environment | ''>(initialEnvironmentFilter);
  const [sortBy, setSortBy] = useState('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  // Update URL when filters change
  const updateURLFilters = (type: string, status: string, environment: string, searchTerm: string) => {
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (status) params.set('status', status);
    if (environment) params.set('environment', environment);
    if (searchTerm) params.set('search', searchTerm);

    const queryString = params.toString();
    navigate(`?${queryString}`, { replace: true });
  };

  const { data, isLoading, error } = useCIs({
    page: page + 1,
    limit: rowsPerPage,
    search: search || undefined,
    type: typeFilter || undefined,
    status: statusFilter || undefined,
    environment: environmentFilter || undefined,
    sort_by: sortBy,
    sort_order: sortOrder,
  });

  const handleSort = (sort: SortOptions) => {
    setSortBy(sort.field);
    setSortOrder(sort.order);
  };

  const handleView = (ci: CI) => {
    if (onView) {
      onView(ci);
    } else {
      navigate(`/cis/${ci.id}`);
    }
  };

  const handleEdit = (ci: CI) => {
    onEdit?.(ci);
  };

  const handleDelete = (ci: CI) => {
    onDelete?.(ci);
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatLabel = (value: string) => {
    return value
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  const searchResults = search
    ? (data?.data || []).map((ci) => ({
        id: ci.id,
        title: ci.name,
        subtitle: formatLabel(ci.environment),
        type: formatLabel(ci.type),
      }))
    : [];

  const columns: DataTableColumn<CI>[] = [
    {
      field: 'name',
      headerName: 'Name',
      sortable: true,
      renderCell: (_value, ci) => (
        <div className="flex items-center gap-3 min-w-0">
          <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-sm bg-sky-soft text-sky-text">
            {typeIcons[ci.type]}
          </span>
          <span className="min-w-0">
            <span className="block font-display font-semibold text-[13.5px] text-navy truncate">
              {ci.name}
            </span>
            <span className="text-[11.5px] text-ink-soft capitalize">{ci.environment}</span>
          </span>
        </div>
      ),
    },
    {
      field: 'type',
      headerName: 'Type',
      sortable: false,
      renderCell: (_value, ci) => <CITypeBadge type={ci.type} />,
    },
    {
      field: 'status',
      headerName: 'Status',
      sortable: false,
      renderCell: (_value, ci) => <CIStatusBadge status={ci.status} />,
    },
    {
      field: 'confidence_score',
      headerName: 'Confidence',
      sortable: false,
      renderCell: (_value, ci) => {
        const healthPct = ci.confidence_score != null ? Math.round(ci.confidence_score * 100) : null;
        return healthPct != null ? (
          <div className="flex items-center gap-2 min-w-[110px]">
            <span className="flex-1 h-1.5 rounded bg-line-soft overflow-hidden">
              <span
                className="block h-full rounded"
                style={{ width: `${healthPct}%`, backgroundColor: healthColor(healthPct) }}
              />
            </span>
            <span className="font-display text-[11.5px] font-bold" style={{ color: healthColor(healthPct) }}>
              {healthPct}%
            </span>
          </div>
        ) : (
          <span className="text-sm text-ink-soft">-</span>
        );
      },
    },
    {
      field: 'updated_at',
      headerName: 'Last Updated',
      sortable: true,
      renderCell: (_value, ci) => (
        <span className="font-display text-xs text-ink-soft">{formatDate(ci.updated_at)}</span>
      ),
    },
  ];

  if (error) {
    return (
      <div className="p-6 text-center">
        <p className="text-danger">Error loading CIs: {error.message}</p>
      </div>
    );
  }

  const statusPills: { value: CIStatus | ''; label: string }[] = [
    { value: '', label: 'All' },
    ...CI_STATUSES.map((status) => ({ value: status, label: formatLabel(status) })),
  ];

  return (
    <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
      {/* Filters */}
      <div className="p-4 border-b border-line space-y-3">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[250px]">
            <SearchBar
              fullWidth
              placeholder="Search items…"
              value={search}
              results={searchResults}
              debounceTime={300}
              onChange={(newValue) => {
                if (newValue === '') {
                  setSearch('');
                  updateURLFilters(typeFilter, statusFilter, environmentFilter, '');
                }
              }}
              onSearch={(newSearch) => {
                setSearch(newSearch);
                updateURLFilters(typeFilter, statusFilter, environmentFilter, newSearch);
              }}
              onResultClick={(result) => navigate(`/cis/${result.id}`)}
            />
          </div>

          <div className="relative min-w-[150px]">
            <Icon name="funnel" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft" />
            <select
              value={typeFilter}
              onChange={(e) => {
                const newType = e.target.value as CIType | '';
                setTypeFilter(newType);
                updateURLFilters(newType, statusFilter, environmentFilter, search);
              }}
              className="w-full pl-10 pr-8 py-2 border-2 border-line rounded-md text-sm appearance-none bg-white text-ink focus:outline-none focus:border-sky focus:ring-4 focus:ring-sky/10"
            >
              <option value="">All Types</option>
              {CI_TYPES.map((type) => (
                <option key={type} value={type}>
                  {formatLabel(type)}
                </option>
              ))}
            </select>
          </div>

          <select
            value={environmentFilter}
            onChange={(e) => {
              const newEnvironment = e.target.value as Environment | '';
              setEnvironmentFilter(newEnvironment);
              updateURLFilters(typeFilter, statusFilter, newEnvironment, search);
            }}
            className="min-w-[150px] px-3 py-2 border-2 border-line rounded-md text-sm appearance-none bg-white text-ink focus:outline-none focus:border-sky focus:ring-4 focus:ring-sky/10"
          >
            <option value="">All Environments</option>
            {ENVIRONMENTS.map((env) => (
              <option key={env} value={env}>
                {formatLabel(env)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap gap-2">
          {statusPills.map((p) => (
            <button
              key={p.value || 'all'}
              onClick={() => {
                setStatusFilter(p.value);
                updateURLFilters(typeFilter, p.value, environmentFilter, search);
              }}
              className={cn(
                'cursor-pointer inline-flex items-center rounded-full border-[1.5px] px-3.5 py-1.5 font-display text-[12.5px] font-semibold transition-colors',
                statusFilter === p.value
                  ? 'border-sky bg-sky-soft text-sky-text'
                  : 'border-line bg-white text-ink-soft hover:border-sky'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <DataTable
        columns={columns}
        data={data?.data || []}
        total={data?.total || 0}
        page={page}
        rowsPerPage={rowsPerPage}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onSortChange={handleSort}
        onPageChange={setPage}
        onRowsPerPageChange={(rows) => {
          setRowsPerPage(rows);
          setPage(0);
        }}
        onRowClick={handleView}
        onView={showActions ? handleView : undefined}
        onEdit={showActions ? onEdit : undefined}
        onDelete={showActions ? onDelete : undefined}
        rowIdField="id"
        emptyMessage="No configuration items match this filter."
        loading={isLoading}
      />
    </LiquidGlass>
  );
};

export default CIList;
