// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Browse, search and filter connector templates. Installation is deploy-time only.
 *
 * Features:
 * - Grid/List view toggle
 * - Search by name/description
 * - Filter by category, verified status
 * - Sort by name, popularity, version, rating
 */

import React, { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  EmptyState,
  Eyebrow,
  Input,
  MetricCard,
  PageHeader,
  Popover,
  SegmentedControl,
  Select,
} from '@happy-technologies/design-system';
import { ConnectorCard } from '@/components/connectors/ConnectorCard';
import { ConnectorDetailModal } from '@/components/connectors/ConnectorDetailModal';
import { QueryState } from '@/components/estate/SurfaceState';
import connectorService, { ConnectorRegistry, InstalledConnector } from '@/services/connector.service';
import { getCategoryLabel } from '@/lib/connector-icons';
import { UNKNOWN_VALUE } from '@/api/connectors';

type ViewMode = 'grid' | 'list';
type SortOption = 'name' | 'downloads' | 'rating' | 'latest';

const SORT_OPTIONS: Array<{ value: SortOption; label: string }> = [
  { value: 'downloads', label: 'Most Downloads' },
  { value: 'rating', label: 'Highest Rated' },
  { value: 'name', label: 'Name (A-Z)' },
  { value: 'latest', label: 'Latest Release' },
];

const CATEGORIES = [
  'cloud',
  'virtualization',
  'container-orchestration',
  'monitoring',
  'security',
  'itsm',
  'identity',
  'endpoint-management',
  'network',
  'storage',
  'backup',
  'asset-management',
  'ticketing',
  'custom'
];

export const ConnectorCatalog: React.FC = () => {
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('downloads');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [selectedConnector, setSelectedConnector] = useState<ConnectorRegistry | null>(null);

  // Fetch connector registry
  const registryQuery = useQuery({
    queryKey: ['connectorRegistry', selectedCategories, verifiedOnly],
    queryFn: () => connectorService.getConnectorRegistry({
      tags: selectedCategories.length > 0 ? selectedCategories : undefined,
      verifiedOnly: verifiedOnly || undefined,
    }),
  });
  const registryConnectors = registryQuery.isError ? undefined : registryQuery.data;

  // Fetch installed connectors
  const installedQuery = useQuery({
    queryKey: ['installedConnectors'],
    queryFn: () => connectorService.getInstalledConnectors(),
  });
  const installedConnectors = installedQuery.isError ? undefined : installedQuery.data;

  // Create a map of installed versions for quick lookup
  const installedMap = useMemo(() => {
    const map = new Map<string, InstalledConnector>();
    installedConnectors?.forEach(c => map.set(c.connectorType, c));
    return map;
  }, [installedConnectors]);

  // Filter and sort connectors
  const filteredConnectors = useMemo(() => {
    let filtered = registryConnectors || [];

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(c =>
        c.name.toLowerCase().includes(query) ||
        c.description.toLowerCase().includes(query) ||
        c.connectorType.toLowerCase().includes(query) ||
        c.tags?.some(tag => tag.toLowerCase().includes(query))
      );
    }

    // Sort
    filtered = [...filtered].sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'downloads':
          return b.downloads - a.downloads;
        case 'rating':
          return b.rating - a.rating;
        case 'latest':
          return new Date(b.versions[0]?.releasedAt || 0).getTime() -
                 new Date(a.versions[0]?.releasedAt || 0).getTime();
        default:
          return 0;
      }
    });

    return filtered;
  }, [registryConnectors, searchQuery, sortBy]);

  const handleCategoryToggle = (category: string) => {
    setSelectedCategories(prev =>
      prev.includes(category)
        ? prev.filter(c => c !== category)
        : [...prev, category]
    );
  };

  // A figure whose source has not loaded (or failed) is unavailable, never a zero.
  const stats = useMemo(() => {
    const available = registryConnectors?.length;
    return {
      total: available,
      installed: installedConnectors?.length,
      verified: registryConnectors?.filter(c => c.verified).length,
      updates:
        registryConnectors && installedConnectors
          ? installedConnectors.filter(ic => {
              const registry = registryConnectors.find(rc => rc.connectorType === ic.connectorType);
              return registry && ic.installedVersion !== registry.latestVersion;
            }).length
          : undefined,
    };
  }, [registryConnectors, installedConnectors]);
  const figure = (value: number | undefined) => (value === undefined ? UNKNOWN_VALUE : value);
  const filterCount = selectedCategories.length + (verifiedOnly ? 1 : 0);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        eyebrow="Registry · Connectors"
        title="Connector Catalog"
        lede="Browse connector templates. Installation and updates are managed through deployment packaging."
      />

      {/* Stats Overview */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        <MetricCard
          icon="package"
          tone="accent"
          label="Available"
          value={figure(stats.total)}
          loading={registryQuery.isPending}
        />
        <MetricCard
          icon="check-circle"
          tone="success"
          label="Installed"
          value={figure(stats.installed)}
          loading={installedQuery.isPending}
        />
        <MetricCard
          icon="clock"
          tone="warning"
          label="Updates Available"
          value={figure(stats.updates)}
          loading={registryQuery.isPending || installedQuery.isPending}
        />
        <MetricCard
          icon="trend-up"
          tone="ai"
          label="Verified"
          value={figure(stats.verified)}
          loading={registryQuery.isPending}
        />
      </div>

      {/* Search and Controls */}
      <Card>
        <div className="flex flex-col gap-4 md:flex-row md:items-center">
          {/* Search */}
          <Input
            icon="magnifying-glass"
            aria-label="Search connectors"
            placeholder="Search connectors by name, description, or tags..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            containerClassName="flex-1"
          />

          {/* Sort */}
          <Select
            aria-label="Sort connectors"
            value={sortBy}
            onChange={(v) => setSortBy(v as SortOption)}
            options={SORT_OPTIONS}
            containerClassName="md:w-[200px]"
          />

          {/* Filters */}
          <Popover
            aria-label="Connector filters"
            align="end"
            trigger={
              <Button variant="outline" icon="sliders-horizontal">
                Filters
                {filterCount > 0 && <Badge variant="info">{filterCount}</Badge>}
              </Button>
            }
          >
            <div className="max-h-96 w-64 space-y-2 overflow-y-auto p-3">
              <Eyebrow>Filter by Category</Eyebrow>
              {CATEGORIES.map(category => (
                <Checkbox
                  key={category}
                  checked={selectedCategories.includes(category)}
                  onChange={() => handleCategoryToggle(category)}
                  label={getCategoryLabel(category)}
                />
              ))}
              <Eyebrow>Other Filters</Eyebrow>
              <Checkbox checked={verifiedOnly} onChange={setVerifiedOnly} label="Verified Only" />
            </div>
          </Popover>

          {/* View Mode Toggle */}
          <SegmentedControl
            aria-label="View mode"
            value={viewMode}
            onChange={setViewMode}
            options={[
              { value: 'grid', icon: 'grid-four', label: <span className="sr-only">Grid view</span> },
              { value: 'list', icon: 'list', label: <span className="sr-only">List view</span> },
            ]}
          />
        </div>

        {/* Active Filters Display */}
        {filterCount > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--hh-border)] pt-4">
            {selectedCategories.map(category => (
              <Chip
                key={category}
                icon="x"
                aria-label={`Remove ${getCategoryLabel(category)} filter`}
                onClick={() => handleCategoryToggle(category)}
              >
                {getCategoryLabel(category)}
              </Chip>
            ))}
            {verifiedOnly && (
              <Chip icon="x" aria-label="Remove Verified Only filter" onClick={() => setVerifiedOnly(false)}>
                Verified Only
              </Chip>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelectedCategories([]);
                setVerifiedOnly(false);
              }}
            >
              Clear All
            </Button>
          </div>
        )}
      </Card>

      {/* Connector Grid/List */}
      {registryQuery.isPending ? (
        <Card>
          <EmptyState loading label="Loading connector catalog…" />
        </Card>
      ) : registryQuery.isError ? (
        <Card>
          <QueryState what="connector catalog" error={registryQuery.error} onRetry={() => void registryQuery.refetch()} />
        </Card>
      ) : (
        <>
          {/* Results Count */}
          <p className="text-sm text-[var(--hh-text-muted)]">
            Showing {filteredConnectors.length} {filteredConnectors.length === 1 ? 'connector' : 'connectors'}
          </p>

          {filteredConnectors.length === 0 ? (
            <Card>
              <EmptyState
                icon="package"
                title="No connectors found"
                description="Try adjusting your search or filters"
              />
            </Card>
          ) : (
            <div
              className={
                viewMode === 'grid'
                  ? 'grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3'
                  : 'space-y-4'
              }
            >
              {filteredConnectors.map(connector => {
                const installed = installedMap.get(connector.connectorType);
                return (
                  <ConnectorCard
                    key={connector.connectorType}
                    connector={connector}
                    isInstalled={!!installed}
                    installedVersion={installed?.installedVersion}
                    onSelect={() => setSelectedConnector(connector)}
                  />
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Detail Modal */}
      {selectedConnector && (
        <ConnectorDetailModal
          connector={selectedConnector}
          installedVersion={installedMap.get(selectedConnector.connectorType)?.installedVersion}
          onClose={() => setSelectedConnector(null)}
        />
      )}
    </div>
  );
};

export default ConnectorCatalog;
