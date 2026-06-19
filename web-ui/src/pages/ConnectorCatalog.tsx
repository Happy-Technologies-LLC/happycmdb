// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector Catalog Page
 * Browse, search, filter, and install connectors from the registry
 *
 * Features:
 * - Grid/List view toggle
 * - Search by name/description
 * - Filter by category, verified status
 * - Sort by name, popularity, version, rating
 * - Install/Update/Uninstall actions
 */

import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Search,
  Grid3x3,
  List,
  SlidersHorizontal,
  Package,
  Download,
  CheckCircle,
  Clock,
  TrendingUp,
  Star,
  ArrowUpDown
} from 'lucide-react';
import { toast } from 'sonner';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConnectorCard } from '@/components/connectors/ConnectorCard';
import { ConnectorDetailModal } from '@/components/connectors/ConnectorDetailModal';
import { ConnectorInstallWizard } from '@/components/connectors/ConnectorInstallWizard';
import connectorService, { ConnectorRegistry, InstalledConnector } from '@/services/connector.service';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { getCategoryLabel } from '@/lib/connector-icons';

type ViewMode = 'grid' | 'list';
type SortOption = 'name' | 'downloads' | 'rating' | 'latest';

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
  const queryClient = useQueryClient();
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('downloads');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [selectedConnector, setSelectedConnector] = useState<ConnectorRegistry | null>(null);
  const [installingConnector, setInstallingConnector] = useState<ConnectorRegistry | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  // Fetch connector registry
  const { data: registryConnectors, isLoading: isLoadingRegistry } = useQuery({
    queryKey: ['connectorRegistry', selectedCategories, verifiedOnly],
    queryFn: () => connectorService.getConnectorRegistry({
      tags: selectedCategories.length > 0 ? selectedCategories : undefined,
      verifiedOnly: verifiedOnly || undefined,
    }),
  });

  // Fetch installed connectors
  const { data: installedConnectors } = useQuery({
    queryKey: ['installedConnectors'],
    queryFn: () => connectorService.getInstalledConnectors(),
  });

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

  // Install connector mutation
  const installMutation = useMutation({
    mutationFn: (connectorType: string) => connectorService.installConnector(connectorType),
    onSuccess: (result) => {
      if (result.success) {
        toast.success(result.message || 'Connector installed successfully');
        queryClient.invalidateQueries({ queryKey: ['installedConnectors'] });
        setInstallingConnector(null);
      } else {
        toast.error(result.message || 'Failed to install connector');
      }
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to install connector');
    },
  });

  // Update connector mutation
  const updateMutation = useMutation({
    mutationFn: (connectorType: string) => connectorService.updateConnector(connectorType),
    onSuccess: (result) => {
      if (result.success) {
        toast.success(result.message || 'Connector updated successfully');
        queryClient.invalidateQueries({ queryKey: ['installedConnectors'] });
      } else {
        toast.error(result.message || 'Failed to update connector');
      }
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to update connector');
    },
  });

  // Uninstall connector mutation
  const uninstallMutation = useMutation({
    mutationFn: (connectorType: string) => connectorService.uninstallConnector(connectorType),
    onSuccess: (result) => {
      if (result.success) {
        toast.success(result.message || 'Connector uninstalled successfully');
        queryClient.invalidateQueries({ queryKey: ['installedConnectors'] });
      } else {
        toast.error(result.message || 'Failed to uninstall connector');
      }
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to uninstall connector');
    },
  });

  const handleCategoryToggle = (category: string) => {
    setSelectedCategories(prev =>
      prev.includes(category)
        ? prev.filter(c => c !== category)
        : [...prev, category]
    );
  };

  const handleInstallClick = (connector: ConnectorRegistry) => {
    const installed = installedMap.get(connector.connectorType);
    if (installed && installed.installedVersion !== connector.latestVersion) {
      // Update available
      updateMutation.mutate(connector.connectorType);
    } else if (!installed) {
      // New installation - open wizard
      setInstallingConnector(connector);
    }
  };

  const stats = useMemo(() => ({
    total: registryConnectors?.length || 0,
    installed: installedConnectors?.length || 0,
    updates: installedConnectors?.filter(ic => {
      const registry = registryConnectors?.find(rc => rc.connectorType === ic.connectorType);
      return registry && ic.installedVersion !== registry.latestVersion;
    }).length || 0,
  }), [registryConnectors, installedConnectors]);

  if (isLoadingRegistry) {
    return <LoadingSpinner />;
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Connector Catalog</h2>
        <p className="text-muted-foreground mt-1">
          Browse and install connectors from the HappyCMDB registry
        </p>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <LiquidGlass variant="default" rounded="lg" className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-100 dark:bg-blue-900/20 rounded-lg">
              <Package className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <div className="text-2xl font-bold">{stats.total}</div>
              <div className="text-sm text-muted-foreground">Available</div>
            </div>
          </div>
        </LiquidGlass>

        <LiquidGlass variant="default" rounded="lg" className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-green-100 dark:bg-green-900/20 rounded-lg">
              <CheckCircle className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <div className="text-2xl font-bold">{stats.installed}</div>
              <div className="text-sm text-muted-foreground">Installed</div>
            </div>
          </div>
        </LiquidGlass>

        <LiquidGlass variant="default" rounded="lg" className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-orange-100 dark:bg-orange-900/20 rounded-lg">
              <Clock className="h-5 w-5 text-orange-600" />
            </div>
            <div>
              <div className="text-2xl font-bold">{stats.updates}</div>
              <div className="text-sm text-muted-foreground">Updates Available</div>
            </div>
          </div>
        </LiquidGlass>

        <LiquidGlass variant="default" rounded="lg" className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-100 dark:bg-purple-900/20 rounded-lg">
              <TrendingUp className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <div className="text-2xl font-bold">
                {registryConnectors?.filter(c => c.verified).length || 0}
              </div>
              <div className="text-sm text-muted-foreground">Verified</div>
            </div>
          </div>
        </LiquidGlass>
      </div>

      {/* Search and Controls */}
      <LiquidGlass variant="default" rounded="xl" className="p-4">
        <div className="flex flex-col md:flex-row gap-4">
          {/* Search */}
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search connectors by name, description, or tags..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>

          {/* Sort */}
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
            <SelectTrigger className="w-full md:w-[180px]">
              <ArrowUpDown className="h-4 w-4 mr-2" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="downloads">Most Downloads</SelectItem>
              <SelectItem value="rating">Highest Rated</SelectItem>
              <SelectItem value="name">Name (A-Z)</SelectItem>
              <SelectItem value="latest">Latest Release</SelectItem>
            </SelectContent>
          </Select>

          {/* Filters */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="w-full md:w-auto">
                <SlidersHorizontal className="h-4 w-4 mr-2" />
                Filters
                {(selectedCategories.length > 0 || verifiedOnly) && (
                  <Badge variant="secondary" className="ml-2">
                    {selectedCategories.length + (verifiedOnly ? 1 : 0)}
                  </Badge>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Filter by Category</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {CATEGORIES.map(category => (
                <DropdownMenuCheckboxItem
                  key={category}
                  checked={selectedCategories.includes(category)}
                  onCheckedChange={() => handleCategoryToggle(category)}
                >
                  {getCategoryLabel(category)}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Other Filters</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={verifiedOnly}
                onCheckedChange={setVerifiedOnly}
              >
                <CheckCircle className="h-4 w-4 mr-2 text-green-500" />
                Verified Only
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* View Mode Toggle */}
          <div className="flex gap-1 border rounded-lg p-1">
            <Button
              variant={viewMode === 'grid' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setViewMode('grid')}
              className="px-3"
            >
              <Grid3x3 className="h-4 w-4" />
            </Button>
            <Button
              variant={viewMode === 'list' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => setViewMode('list')}
              className="px-3"
            >
              <List className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Active Filters Display */}
        {(selectedCategories.length > 0 || verifiedOnly) && (
          <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t">
            {selectedCategories.map(category => (
              <Badge
                key={category}
                variant="secondary"
                className="cursor-pointer"
                onClick={() => handleCategoryToggle(category)}
              >
                {getCategoryLabel(category)}
                <span className="ml-2">×</span>
              </Badge>
            ))}
            {verifiedOnly && (
              <Badge
                variant="secondary"
                className="cursor-pointer"
                onClick={() => setVerifiedOnly(false)}
              >
                Verified Only
                <span className="ml-2">×</span>
              </Badge>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelectedCategories([]);
                setVerifiedOnly(false);
              }}
              className="h-6 px-2 text-xs"
            >
              Clear All
            </Button>
          </div>
        )}
      </LiquidGlass>

      {/* Results Count */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Showing {filteredConnectors.length} {filteredConnectors.length === 1 ? 'connector' : 'connectors'}
        </p>
      </div>

      {/* Connector Grid/List */}
      {filteredConnectors.length === 0 ? (
        <LiquidGlass variant="default" rounded="xl" className="p-12 text-center">
          <Package className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold mb-2">No connectors found</h3>
          <p className="text-sm text-muted-foreground">
            Try adjusting your search or filters
          </p>
        </LiquidGlass>
      ) : (
        <div
          className={
            viewMode === 'grid'
              ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'
              : 'space-y-4'
          }
        >
          {filteredConnectors.map(connector => {
            const installed = installedMap.get(connector.connectorType);
            return (
              <div
                key={connector.connectorType}
                onClick={() => setSelectedConnector(connector)}
                className="cursor-pointer"
              >
                <ConnectorCard
                  connector={connector}
                  onInstall={() => handleInstallClick(connector)}
                  isInstalled={!!installed}
                  installedVersion={installed?.installedVersion}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Detail Modal */}
      {selectedConnector && (
        <ConnectorDetailModal
          connector={selectedConnector}
          installedVersion={installedMap.get(selectedConnector.connectorType)?.installedVersion}
          onClose={() => setSelectedConnector(null)}
          onInstall={() => handleInstallClick(selectedConnector)}
          onUninstall={(connectorType) => {
            uninstallMutation.mutate(connectorType);
            setSelectedConnector(null);
          }}
        />
      )}

      {/* Install Wizard */}
      {installingConnector && (
        <ConnectorInstallWizard
          connector={installingConnector}
          onClose={() => setInstallingConnector(null)}
          onComplete={() => {
            queryClient.invalidateQueries({ queryKey: ['installedConnectors'] });
            setInstallingConnector(null);
          }}
        />
      )}
    </div>
  );
};

export default ConnectorCatalog;
