// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useEffect, useRef, useState } from 'react';
import {
  Button,
  Card,
  Chip,
  ConfidenceBar,
  DataTable,
  EmptyState,
  IconButton,
  NativeSelect,
  Pagination,
  SearchInput,
  fmtDate,
  type Column,
  type DataTableSort,
} from '@happy-technologies/design-system';
import { useNavigate } from 'react-router-dom';
import { useCIs } from '../../hooks/useCIs';
import { CI, CIType, CIStatus, Environment } from '../../services/ci.service';
import { classifyError } from '../../lib/estate';
import { QueryState } from '../estate/SurfaceState';
import CIStatusBadge from './CIStatusBadge';
import CITypeBadge, { typeIcons } from './CITypeBadge';
import CIDrawer from './CIDrawer';

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

const ROWS_PER_PAGE = [5, 10, 25, 50, 100];

/** How long typing pauses before the search term is applied. */
const SEARCH_DEBOUNCE_MS = 300;

const formatLabel = (value: string) =>
  value
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

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
  const [searchText, setSearchText] = useState(initialSearch);
  const [typeFilter, setTypeFilter] = useState<CIType | ''>(initialTypeFilter);
  const [statusFilter, setStatusFilter] = useState<CIStatus | ''>(initialStatusFilter);
  const [environmentFilter, setEnvironmentFilter] = useState<Environment | ''>(initialEnvironmentFilter);
  const [sortBy, setSortBy] = useState('name');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [peekCI, setPeekCI] = useState<CI | null>(null);

  // The debounced search commit reads the filters as they are when it fires, not when typing started.
  const filters = useRef({ typeFilter, statusFilter, environmentFilter });
  filters.current = { typeFilter, statusFilter, environmentFilter };
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(searchTimer.current), []);

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

  const { data, isLoading, error, refetch } = useCIs({
    page: page + 1,
    limit: rowsPerPage,
    search: search || undefined,
    type: typeFilter || undefined,
    status: statusFilter || undefined,
    environment: environmentFilter || undefined,
    sort_by: sortBy,
    sort_order: sortOrder,
  });

  const commitSearch = (value: string) => {
    setSearch(value);
    updateURLFilters(
      filters.current.typeFilter,
      filters.current.statusFilter,
      filters.current.environmentFilter,
      value
    );
  };

  const handleSearchChange = (value: string) => {
    setSearchText(value);
    clearTimeout(searchTimer.current);
    if (value === '') {
      commitSearch('');
    } else {
      searchTimer.current = setTimeout(() => commitSearch(value), SEARCH_DEBOUNCE_MS);
    }
  };

  const handleSort = (sort: DataTableSort) => {
    setSortBy(sort.key);
    setSortOrder(sort.direction);
  };

  const handleView = (ci: CI) => {
    if (onView) {
      onView(ci);
    } else {
      navigate(`/cis/${ci.id}`);
    }
  };

  const rows = data?.data || [];
  const total = data?.total || 0;
  const pageCount = Math.max(1, Math.ceil(total / rowsPerPage));

  const columns: Array<Column<CI>> = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      render: (ci) => (
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[var(--hh-radius-sm)] bg-[var(--hh-accent-bg)] text-[var(--hh-accent-text)]">
            {typeIcons[ci.type]}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-semibold text-[var(--hh-text-primary)]">{ci.name}</span>
            <span className="text-[11.5px] text-[var(--hh-text-muted)] capitalize">{ci.environment}</span>
          </span>
        </div>
      ),
    },
    { header: 'Type', render: (ci) => <CITypeBadge type={ci.type} /> },
    { header: 'Status', render: (ci) => <CIStatusBadge status={ci.status} /> },
    {
      header: 'Confidence',
      render: (ci) =>
        ci.confidence_score != null ? (
          <ConfidenceBar value={ci.confidence_score} />
        ) : (
          <span className="text-[var(--hh-text-muted)]">-</span>
        ),
    },
    {
      key: 'updated_at',
      header: 'Last Updated',
      sortable: true,
      render: (ci) => <span className="text-xs text-[var(--hh-text-muted)]">{fmtDate(ci.updated_at)}</span>,
    },
    {
      header: showActions ? 'Actions' : 'Quick view',
      className: 'w-32 text-right',
      render: (ci) => (
        <div className="flex justify-end gap-1">
          <IconButton
            icon="sidebar-simple"
            variant="ghost"
            size="sm"
            title="Quick view"
            aria-label={`Quick view ${ci.name}`}
            onClick={() => setPeekCI(ci)}
          />
          {showActions && (
            <IconButton
              icon="eye"
              variant="ghost"
              size="sm"
              title="View Details"
              aria-label={`View details for ${ci.name}`}
              onClick={() => handleView(ci)}
            />
          )}
          {showActions && onEdit && (
            <IconButton
              icon="pencil-simple"
              variant="ghost"
              size="sm"
              title="Edit"
              aria-label={`Edit ${ci.name}`}
              onClick={() => onEdit(ci)}
            />
          )}
          {showActions && onDelete && (
            <IconButton
              icon="trash"
              variant="ghost"
              size="sm"
              title="Delete"
              aria-label={`Delete ${ci.name}`}
              onClick={() => onDelete(ci)}
            />
          )}
        </div>
      ),
    },
  ];

  const statusPills: { value: CIStatus | ''; label: string }[] = [
    { value: '', label: 'All' },
    ...CI_STATUSES.map((status) => ({ value: status, label: formatLabel(status) })),
  ];

  const failure = error ? classifyError(error) : null;

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput
            className="min-w-[250px] flex-1"
            placeholder="Search items…"
            value={searchText}
            onChange={handleSearchChange}
          />

          <NativeSelect
            size="sm"
            aria-label="Filter by type"
            containerClassName="min-w-[150px]"
            value={typeFilter}
            onChange={(e) => {
              const newType = e.target.value as CIType | '';
              setTypeFilter(newType);
              updateURLFilters(newType, statusFilter, environmentFilter, search);
            }}
          >
            <option value="">All Types</option>
            {CI_TYPES.map((type) => (
              <option key={type} value={type}>
                {formatLabel(type)}
              </option>
            ))}
          </NativeSelect>

          <NativeSelect
            size="sm"
            aria-label="Filter by environment"
            containerClassName="min-w-[150px]"
            value={environmentFilter}
            onChange={(e) => {
              const newEnvironment = e.target.value as Environment | '';
              setEnvironmentFilter(newEnvironment);
              updateURLFilters(typeFilter, statusFilter, newEnvironment, search);
            }}
          >
            <option value="">All Environments</option>
            {ENVIRONMENTS.map((env) => (
              <option key={env} value={env}>
                {formatLabel(env)}
              </option>
            ))}
          </NativeSelect>
        </div>

        <div className="flex flex-wrap gap-2">
          {statusPills.map((p) => (
            <Chip
              key={p.value || 'all'}
              active={statusFilter === p.value}
              onClick={() => {
                setStatusFilter(p.value);
                updateURLFilters(typeFilter, p.value, environmentFilter, search);
              }}
            >
              {p.label}
            </Chip>
          ))}
        </div>
      </Card>

      {failure ? (
        failure.kind === 'forbidden' ? (
          <QueryState what="configuration items" error={error} />
        ) : (
          <EmptyState
            tone="danger"
            icon="warning-circle"
            title="Error loading CIs"
            description={failure.message}
            action={
              <Button size="sm" variant="secondary" onClick={() => void refetch()}>
                Try again
              </Button>
            }
          />
        )
      ) : (
        <DataTable
          aria-busy={isLoading}
          caption="Configuration items"
          columns={columns}
          rows={rows}
          rowKey={(ci) => ci.id}
          loading={isLoading}
          emptyLabel="No configuration items match this filter."
          sort={{ key: sortBy, direction: sortOrder }}
          onSortChange={handleSort}
          onRowClick={handleView}
          footer={
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-[var(--hh-text-muted)]">
                <span aria-hidden="true">Rows per page</span>
                <NativeSelect
                  size="sm"
                  aria-label="Rows per page"
                  value={rowsPerPage}
                  onChange={(e) => {
                    setRowsPerPage(Number(e.target.value));
                    setPage(0);
                  }}
                >
                  {ROWS_PER_PAGE.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <Pagination page={page + 1} pageCount={pageCount} onChange={(next) => setPage(next - 1)} />
            </div>
          }
        />
      )}

      {peekCI && (
        <CIDrawer
          ciId={peekCI.id}
          open
          onClose={() => setPeekCI(null)}
          onOpenFull={() => {
            const ci = peekCI;
            setPeekCI(null);
            handleView(ci);
          }}
        />
      )}
    </div>
  );
};

export default CIList;
