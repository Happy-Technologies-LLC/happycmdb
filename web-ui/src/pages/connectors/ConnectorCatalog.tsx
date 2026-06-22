// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  FormDialog,
  FormDialogContent,
  FormDialogHeader,
  FormDialogBody,
  FormDialogTitle,
  FormDialogDescription,
} from '@/components/ui/form-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConnectorCard } from '@/components/connectors/ConnectorCard';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import {
  connectorService,
  ConnectorRegistry,
  InstalledConnector,
} from '@/services/connector.service';
import { useToast } from '@/contexts/ToastContext';

export default function ConnectorCatalog() {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [connectors, setConnectors] = useState<ConnectorRegistry[]>([]);
  const [installedConnectors, setInstalledConnectors] = useState<InstalledConnector[]>([]);
  const [selectedConnector, setSelectedConnector] = useState<ConnectorRegistry | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string>('');

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | 'DISCOVERY' | 'CONNECTOR'>('all');
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [catalogData, installedData] = await Promise.all([
        connectorService.getConnectorRegistry(),
        connectorService.getInstalledConnectors(),
      ]);
      setConnectors(catalogData);
      setInstalledConnectors(installedData);
    } catch (error: any) {
      showToast(error.message || 'Failed to load connector catalog', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleInstallClick = (connector: ConnectorRegistry) => {
    setSelectedConnector(connector);
    setSelectedVersion(connector.latestVersion);
  };

  const handleInstall = async () => {
    if (!selectedConnector) return;

    try {
      setInstalling(true);
      const result = await connectorService.installConnector(
        selectedConnector.connectorType,
        selectedVersion
      );

      if (result.success) {
        showToast(`${selectedConnector.name} installed successfully`, 'success');
        await loadData();
        setSelectedConnector(null);
      } else {
        showToast(result.message || 'Unknown error occurred', 'error');
      }
    } catch (error: any) {
      showToast(error.message || 'Failed to install connector', 'error');
    } finally {
      setInstalling(false);
    }
  };

  const isConnectorInstalled = (connectorType: string) => {
    return installedConnectors.find((c) => c.connectorType === connectorType);
  };

  const getInstalledVersion = (connectorType: string) => {
    return installedConnectors.find((c) => c.connectorType === connectorType)?.installedVersion;
  };

  // Get all unique tags
  const allTags = Array.from(
    new Set(connectors.flatMap((c) => c.tags || []))
  ).sort();

  // Filter connectors
  const filteredConnectors = connectors.filter((connector) => {
    // Search filter
    if (searchTerm) {
      const search = searchTerm.toLowerCase();
      const matchesSearch =
        connector.name.toLowerCase().includes(search) ||
        connector.description.toLowerCase().includes(search) ||
        connector.tags.some((tag) => tag.toLowerCase().includes(search));
      if (!matchesSearch) return false;
    }

    // Category filter
    if (categoryFilter !== 'all' && connector.category !== categoryFilter) {
      return false;
    }

    // Verified filter
    if (verifiedOnly && !connector.verified) {
      return false;
    }

    // Tags filter
    if (selectedTags.length > 0) {
      const hasMatchingTag = selectedTags.some((tag) => connector.tags.includes(tag));
      if (!hasMatchingTag) return false;
    }

    return true;
  });

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const clearFilters = () => {
    setSearchTerm('');
    setCategoryFilter('all');
    setVerifiedOnly(false);
    setSelectedTags([]);
  };

  const hasActiveFilters = searchTerm || categoryFilter !== 'all' || verifiedOnly || selectedTags.length > 0;

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold mb-2">Connector Catalog</h1>
        <p className="text-muted-foreground">
          Browse and install pre-built connectors for your CMDB
        </p>
      </div>

      {/* Filters */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row gap-3">
          {/* Search */}
          <div className="relative flex-1">
            <Icon name="magnifying-glass" size={16} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search connectors..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Category */}
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as any)}
            className="px-3 py-2 rounded-md border border-input bg-background text-sm min-w-[180px]"
          >
            <option value="all">All Categories</option>
            <option value="DISCOVERY">Discovery Workers</option>
            <option value="CONNECTOR">Integration Connectors</option>
          </select>

          {/* Verified Only */}
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-input bg-background whitespace-nowrap">
            <Checkbox
              id="verified"
              checked={verifiedOnly}
              onCheckedChange={(checked) => setVerifiedOnly(checked as boolean)}
            />
            <label htmlFor="verified" className="text-sm cursor-pointer">
              Verified Only
            </label>
          </div>

          {/* Clear Filters */}
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="whitespace-nowrap">
              <Icon name="x" size={16} className="mr-1" />
              Clear
            </Button>
          )}
        </div>

        {/* Tags Filter */}
        {allTags.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <Icon name="funnel" size={16} className="text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Tags:</span>
            {allTags.slice(0, 15).map((tag) => (
              <Badge
                key={tag}
                variant={selectedTags.includes(tag) ? 'default' : 'outline'}
                className="cursor-pointer"
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* Results Count */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Showing {filteredConnectors.length} of {connectors.length} connectors
        </p>
      </div>

      {/* Connector Grid */}
      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      ) : filteredConnectors.length === 0 ? (
        <Alert>
          <AlertDescription>
            No connectors found matching your criteria. Try adjusting your filters.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredConnectors.map((connector) => {
            const installed = isConnectorInstalled(connector.connectorType);
            const installedVersion = getInstalledVersion(connector.connectorType);
            return (
              <ConnectorCard
                key={connector.connectorType}
                connector={connector}
                onInstall={() => handleInstallClick(connector)}
                isInstalled={!!installed}
                installedVersion={installedVersion}
              />
            );
          })}
        </div>
      )}

      {/* Install Dialog */}
      <FormDialog open={!!selectedConnector} onOpenChange={() => setSelectedConnector(null)}>
        <FormDialogContent className="max-w-2xl">
          <FormDialogHeader>
            <FormDialogTitle>Install {selectedConnector?.name}</FormDialogTitle>
            <FormDialogDescription>
              Select a version to install this connector
            </FormDialogDescription>
          </FormDialogHeader>

          <FormDialogBody>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">Version</label>
                <select
                  value={selectedVersion}
                  onChange={(e) => setSelectedVersion(e.target.value)}
                  className="w-full px-3 py-2 rounded-md border border-input bg-background"
                  disabled={installing}
                >
                  {selectedConnector?.versions.map((version) => (
                    <option key={version.version} value={version.version}>
                      v{version.version}
                      {version.version === selectedConnector.latestVersion && ' (Latest)'}
                      {version.breakingChanges && ' ⚠️ Breaking Changes'}
                    </option>
                  ))}
                </select>
              </div>

              {selectedConnector?.versions.find((v) => v.version === selectedVersion)
                ?.changelog && (
                <div>
                  <label className="text-sm font-medium mb-2 block">Changelog</label>
                  <div className="p-3 rounded-md bg-muted text-sm">
                    {
                      selectedConnector.versions.find((v) => v.version === selectedVersion)
                        ?.changelog
                    }
                  </div>
                </div>
              )}

              <Alert>
                <AlertDescription className="text-xs">
                  Size:{' '}
                  {(
                    (selectedConnector?.versions.find((v) => v.version === selectedVersion)
                      ?.sizeBytes || 0) /
                    1024 /
                    1024
                  ).toFixed(2)}{' '}
                  MB
                </AlertDescription>
              </Alert>

              <div className="flex justify-end gap-2 pt-4">
                <Button
                  variant="outline"
                  onClick={() => setSelectedConnector(null)}
                  disabled={installing}
                >
                  Cancel
                </Button>
                <Button onClick={handleInstall} disabled={installing}>
                  {installing ? 'Installing...' : 'Install'}
                </Button>
              </div>
            </div>
          </FormDialogBody>
        </FormDialogContent>
      </FormDialog>
    </div>
  );
}
