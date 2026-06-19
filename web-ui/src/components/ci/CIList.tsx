// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import {
  Search,
  Pencil,
  Trash2,
  Eye,
  Filter,
  ArrowUp,
  ArrowDown,
  ChevronRight,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useCIs } from '../../hooks/useCIs';
import { CI, CIType, CIStatus, Environment } from '../../services/ci.service';
import CIStatusBadge from './CIStatusBadge';
import CITypeBadge, { typeIcons } from './CITypeBadge';
import { cn } from '../../utils/cn';
import { LiquidGlass } from '../ui/liquid-glass';
import { healthColor } from '../../lib/brandColors';

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

  const handleSort = (column: string) => {
    const isAsc = sortBy === column && sortOrder === 'asc';
    setSortOrder(isAsc ? 'desc' : 'asc');
    setSortBy(column);
  };

  const handleView = (ci: CI) => {
    if (onView) {
      onView(ci);
    } else {
      navigate(`/cis/${ci.id}`);
    }
  };

  const handleEdit = (ci: CI, e: React.MouseEvent) => {
    e.stopPropagation();
    if (onEdit) {
      onEdit(ci);
    }
  };

  const handleDelete = (ci: CI, e: React.MouseEvent) => {
    e.stopPropagation();
    if (onDelete) {
      onDelete(ci);
    }
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
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-soft" />
            <input
              type="text"
              placeholder="Search items…"
              value={search}
              onChange={(e) => {
                const newSearch = e.target.value;
                setSearch(newSearch);
                updateURLFilters(typeFilter, statusFilter, environmentFilter, newSearch);
              }}
              className="w-full pl-10 pr-3 py-2 border-2 border-line rounded-md text-sm bg-white text-ink focus:outline-none focus:border-sky focus:ring-4 focus:ring-sky/10"
            />
          </div>

          <div className="relative min-w-[150px]">
            <Filter className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-soft" />
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
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-warm border-b border-line">
            <tr>
              <th className="px-[22px] py-3 text-left">
                <button
                  onClick={() => handleSort('name')}
                  className="flex items-center gap-1 font-display text-[10.5px] font-bold tracking-[0.08em] uppercase text-ink-soft hover:text-navy"
                >
                  Name
                  {sortBy === 'name' && (
                    sortOrder === 'asc' ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />
                  )}
                </button>
              </th>
              <th className="px-[22px] py-3 text-left font-display text-[10.5px] font-bold tracking-[0.08em] uppercase text-ink-soft">
                Type
              </th>
              <th className="px-[22px] py-3 text-left font-display text-[10.5px] font-bold tracking-[0.08em] uppercase text-ink-soft">
                Status
              </th>
              <th className="px-[22px] py-3 text-left font-display text-[10.5px] font-bold tracking-[0.08em] uppercase text-ink-soft">
                Confidence
              </th>
              <th className="px-[22px] py-3 text-left">
                <button
                  onClick={() => handleSort('updated_at')}
                  className="flex items-center gap-1 font-display text-[10.5px] font-bold tracking-[0.08em] uppercase text-ink-soft hover:text-navy"
                >
                  Last Updated
                  {sortBy === 'updated_at' && (
                    sortOrder === 'asc' ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />
                  )}
                </button>
              </th>
              <th className="px-[22px] py-3 text-right font-display text-[10.5px] font-bold tracking-[0.08em] uppercase text-ink-soft">
                {showActions ? 'Actions' : ''}
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center">
                  <div className="flex justify-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-sky"></div>
                  </div>
                </td>
              </tr>
            ) : data?.data.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-sm text-ink-soft">
                  No configuration items match this filter.
                </td>
              </tr>
            ) : (
              data?.data.map((ci) => {
                const healthPct =
                  ci.confidence_score != null ? Math.round(ci.confidence_score * 100) : null;
                return (
                  <tr
                    key={ci.id}
                    onClick={() => handleView(ci)}
                    className="border-b border-line-soft hover:bg-warm cursor-pointer transition-colors"
                  >
                    <td className="px-[22px] py-[15px]">
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
                    </td>
                    <td className="px-[22px] py-[15px]">
                      <CITypeBadge type={ci.type} />
                    </td>
                    <td className="px-[22px] py-[15px]">
                      <CIStatusBadge status={ci.status} />
                    </td>
                    <td className="px-[22px] py-[15px]">
                      {healthPct != null ? (
                        <div className="flex items-center gap-2 min-w-[110px]">
                          <span className="flex-1 h-1.5 rounded bg-line-soft overflow-hidden">
                            <span
                              className="block h-full rounded"
                              style={{ width: `${healthPct}%`, backgroundColor: healthColor(healthPct) }}
                            />
                          </span>
                          <span
                            className="font-display text-[11.5px] font-bold"
                            style={{ color: healthColor(healthPct) }}
                          >
                            {healthPct}%
                          </span>
                        </div>
                      ) : (
                        <span className="text-sm text-ink-soft">—</span>
                      )}
                    </td>
                    <td className="px-[22px] py-[15px]">
                      <span className="font-display text-xs text-ink-soft">{formatDate(ci.updated_at)}</span>
                    </td>
                    {showActions ? (
                      <td className="px-[22px] py-[15px] text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => handleView(ci)}
                            className="p-1.5 hover:bg-warm-alt rounded transition-colors"
                            title="View Details"
                          >
                            <Eye className="w-4 h-4 text-ink-soft" />
                          </button>
                          {onEdit && (
                            <button
                              onClick={(e) => handleEdit(ci, e)}
                              className="p-1.5 hover:bg-sky-soft rounded transition-colors"
                              title="Edit"
                            >
                              <Pencil className="w-4 h-4 text-sky-text" />
                            </button>
                          )}
                          {onDelete && (
                            <button
                              onClick={(e) => handleDelete(ci, e)}
                              className="p-1.5 hover:bg-danger-soft rounded transition-colors"
                              title="Delete"
                            >
                              <Trash2 className="w-4 h-4 text-danger" />
                            </button>
                          )}
                        </div>
                      </td>
                    ) : (
                      <td className="px-[22px] py-[15px] text-center">
                        <ChevronRight className="w-4 h-4 text-ink-soft inline" />
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="px-4 py-3 flex items-center justify-between border-t border-line">
        <div className="flex items-center gap-2">
          <span className="text-sm text-ink">Rows per page:</span>
          <select
            value={rowsPerPage}
            onChange={(e) => {
              setRowsPerPage(parseInt(e.target.value, 10));
              setPage(0);
            }}
            className="px-2 py-1 border border-line rounded text-sm bg-white text-ink focus:outline-none focus:border-sky focus:ring-2 focus:ring-sky/20"
          >
            {[5, 10, 25, 50].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-ink">
            {page * rowsPerPage + 1}-{Math.min((page + 1) * rowsPerPage, data?.total || 0)} of{' '}
            {data?.total || 0}
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="px-3 py-1 border border-line rounded text-sm bg-white text-ink hover:bg-warm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(page + 1)}
              disabled={!data || (page + 1) * rowsPerPage >= data.total}
              className="px-3 py-1 border border-line rounded text-sm bg-white text-ink hover:bg-warm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </LiquidGlass>
  );
};

export default CIList;
