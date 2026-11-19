// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Icon,
  SectionHeading,
} from '@happy-technologies/design-system';
import { QueryState } from '@/components/estate/SurfaceState';
import { ConnectorResource } from '@/services/connector.service';

interface ResourceSelectorProps {
  resources: ConnectorResource[];
  selectedResources: string[];
  resourceConfigs: Record<string, any>;
  onChange: (resources: string[], configs: Record<string, any>) => void;
  showDependencies?: boolean;
  /** The resource list is still being read: shows the loading state, never a count. */
  loading?: boolean;
  /** The resource list failed to load (403 shows the no-access state); shows the failure, never a count. */
  error?: unknown;
  /** Retry the failed read; the failure state offers "Try again" only when given. */
  onRetry?: () => void;
}

export function ResourceSelector({
  resources,
  selectedResources,
  resourceConfigs,
  onChange,
  showDependencies = true,
  loading,
  error,
  onRetry,
}: ResourceSelectorProps) {
  const [expandedResources, setExpandedResources] = useState<Set<string>>(new Set());

  const handleToggleResource = (resourceId: string, enabled: boolean) => {
    let newResources: string[];

    if (enabled) {
      // Add resource and its dependencies
      const resource = resources.find((r) => r.id === resourceId);
      const deps = resource?.extraction?.dependsOn || [];
      newResources = [...new Set([...selectedResources, resourceId, ...deps])];
    } else {
      // Remove resource and dependents
      const dependents = resources
        .filter((r) => r.extraction?.dependsOn?.includes(resourceId))
        .map((r) => r.id);
      newResources = selectedResources.filter(
        (id) => id !== resourceId && !dependents.includes(id)
      );
    }

    onChange(newResources, resourceConfigs);
  };

  const handleResourceConfigChange = (resourceId: string, config: any) => {
    const newConfigs = { ...resourceConfigs, [resourceId]: config };
    onChange(selectedResources, newConfigs);
  };

  const toggleExpanded = (resourceId: string) => {
    setExpandedResources((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(resourceId)) {
        newSet.delete(resourceId);
      } else {
        newSet.add(resourceId);
      }
      return newSet;
    });
  };

  const isResourceEnabled = (resourceId: string) => {
    return selectedResources.includes(resourceId);
  };

  const hasUnmetDependencies = (resource: ConnectorResource) => {
    if (!resource.extraction?.dependsOn) return false;
    return resource.extraction.dependsOn.some(
      (depId) => !selectedResources.includes(depId)
    );
  };

  const getDependentResources = (resourceId: string) => {
    return resources.filter((r) => r.extraction?.dependsOn?.includes(resourceId));
  };

  if (loading || error != null) {
    return (
      <QueryState what="connector resources" loading={loading} error={error} onRetry={onRetry} />
    );
  }

  if (resources.length === 0) {
    return (
      <EmptyState
        icon="stack"
        title="No resources available for this connector"
        description="This connector does not list any resources to sync."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <SectionHeading level={3} className="mb-1">
            Select Resources to Sync
          </SectionHeading>
          <p className="text-sm text-[var(--hh-text-muted)]">
            Choose which resources this connector should synchronize
          </p>
        </div>
        <Badge variant="neutral">
          {selectedResources.length} / {resources.length} selected
        </Badge>
      </div>

      <div className="space-y-3">
        {resources.map((resource) => {
          const isEnabled = isResourceEnabled(resource.id);
          const isExpanded = expandedResources.has(resource.id);
          const hasMissingDeps = hasUnmetDependencies(resource);
          const dependents = getDependentResources(resource.id);
          const hasConfig = resource.configurationSchema && Object.keys(resource.configurationSchema).length > 0;

          return (
            <Card
              key={resource.id}
              className={[
                'p-4 transition-all',
                isEnabled ? 'border-[var(--hh-accent-text)]' : '',
                hasMissingDeps ? 'border-[var(--hh-warning-text)]' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className="space-y-3">
                {/* Resource Header */}
                <div className="flex flex-wrap items-center gap-2">
                  <Checkbox
                    id={resource.id}
                    checked={isEnabled}
                    disabled={hasMissingDeps}
                    onChange={(checked) => handleToggleResource(resource.id, checked)}
                    label={resource.name}
                  />
                  {resource.enabledByDefault && <Badge variant="info">Recommended</Badge>}
                  {resource.ciType && <Badge variant="neutral">{resource.ciType}</Badge>}
                </div>

                <div className="min-w-0 pl-7">
                  {resource.description && (
                    <p className="mb-2 text-xs text-[var(--hh-text-muted)]">
                      {resource.description}
                    </p>
                  )}

                  {/* Operations */}
                  {resource.operations && resource.operations.length > 0 && (
                    <div className="mb-2 flex flex-wrap items-center gap-1">
                      <span className="text-xs text-[var(--hh-text-muted)]">Operations:</span>
                      {resource.operations.map((op) => (
                        <Badge key={op} variant="neutral">
                          {op}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Extraction Info */}
                  {resource.extraction && (
                    <div className="flex flex-wrap items-center gap-4 text-xs text-[var(--hh-text-muted)]">
                      {resource.extraction.incremental && (
                        <div className="flex items-center gap-1">
                          <Icon name="arrows-clockwise" size={12} />
                          <span>Incremental</span>
                        </div>
                      )}
                      {resource.extraction.batchSize && (
                        <div className="flex items-center gap-1">
                          <Icon name="stack" size={12} />
                          <span>Batch: {resource.extraction.batchSize}</span>
                        </div>
                      )}
                      {resource.extraction.rateLimit && (
                        <div className="flex items-center gap-1">
                          <Icon name="timer" size={12} />
                          <span>Limit: {resource.extraction.rateLimit} req/s</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Dependencies Warning */}
                  {hasMissingDeps && (
                    <Banner tone="danger" icon="warning-circle" className="mt-2">
                      This resource requires:{' '}
                      {resource.extraction?.dependsOn
                        ?.filter((depId) => !selectedResources.includes(depId))
                        .map((depId) => resources.find((r) => r.id === depId)?.name)
                        .join(', ')}
                    </Banner>
                  )}

                  {/* Dependencies Display */}
                  {showDependencies &&
                    resource.extraction?.dependsOn &&
                    resource.extraction.dependsOn.length > 0 && (
                      <div className="mt-2 rounded-md bg-[var(--hh-bg-elevated)] p-2">
                        <div className="mb-1 flex items-center gap-1 text-xs text-[var(--hh-text-muted)]">
                          <Icon name="link" size={12} />
                          <span>Depends on:</span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {resource.extraction.dependsOn.map((depId) => {
                            const depResource = resources.find((r) => r.id === depId);
                            const isDepEnabled = selectedResources.includes(depId);
                            return (
                              <Badge key={depId} variant={isDepEnabled ? 'success' : 'neutral'}>
                                {depResource?.name || depId}
                              </Badge>
                            );
                          })}
                        </div>
                      </div>
                    )}

                  {/* Dependents Display */}
                  {showDependencies && isEnabled && dependents.length > 0 && (
                    <div className="mt-2 rounded-md bg-[var(--hh-bg-elevated)] p-2">
                      <div className="mb-1 flex items-center gap-1 text-xs text-[var(--hh-text-muted)]">
                        <Icon name="link" size={12} />
                        <span>Required by:</span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {dependents.map((dep) => (
                          <Badge key={dep.id} variant="neutral">
                            {dep.name}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Resource Configuration */}
                  {isEnabled && hasConfig && (
                    <Button
                      variant="link"
                      size="sm"
                      className="mt-2"
                      onClick={() => toggleExpanded(resource.id)}
                    >
                      {isExpanded ? 'Hide' : 'Show'} Configuration
                    </Button>
                  )}
                </div>

                {/* Configuration Form */}
                {isEnabled && hasConfig && isExpanded && (
                  <div className="pl-7">
                    <div className="mt-2 space-y-2 rounded-md bg-[var(--hh-bg-elevated)] p-3">
                      <SectionHeading level={4} className="mb-2">
                        Resource Configuration
                      </SectionHeading>
                      {/* TODO: Implement dynamic form based on configurationSchema */}
                      <div className="text-xs text-[var(--hh-text-muted)]">
                        Configuration form for {resource.name} will be rendered here
                        based on schema
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Summary */}
      <div className="flex items-center justify-between border-t border-[var(--hh-surface-edge)] pt-2">
        <div className="text-sm text-[var(--hh-text-muted)]">
          <strong>{selectedResources.length}</strong> of <strong>{resources.length}</strong>{' '}
          resources selected
        </div>
        {selectedResources.length > 0 && (
          <Button variant="danger" size="sm" onClick={() => onChange([], {})}>
            Clear all
          </Button>
        )}
      </div>
    </div>
  );
}
