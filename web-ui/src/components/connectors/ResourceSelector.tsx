// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { RefreshCw, Layers, Timer, Link, AlertCircle } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConnectorResource } from '@/services/connector.service';
import { cn } from '@/lib/utils';

interface ResourceSelectorProps {
  resources: ConnectorResource[];
  selectedResources: string[];
  resourceConfigs: Record<string, any>;
  onChange: (resources: string[], configs: Record<string, any>) => void;
  showDependencies?: boolean;
}

export function ResourceSelector({
  resources,
  selectedResources,
  resourceConfigs,
  onChange,
  showDependencies = true,
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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Select Resources to Sync</h3>
          <p className="text-sm text-muted-foreground">
            Choose which resources this connector should synchronize
          </p>
        </div>
        <Badge variant="outline" className="text-sm">
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
              className={cn(
                'p-4 transition-all',
                isEnabled && 'border-primary',
                hasMissingDeps && 'border-warning'
              )}
            >
              <Collapsible open={isExpanded} onOpenChange={() => toggleExpanded(resource.id)}>
                <div className="space-y-3">
                  {/* Resource Header */}
                  <div className="flex items-start gap-3">
                    <Checkbox
                      id={resource.id}
                      checked={isEnabled}
                      disabled={hasMissingDeps}
                      onCheckedChange={(checked) =>
                        handleToggleResource(resource.id, checked as boolean)
                      }
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <label
                          htmlFor={resource.id}
                          className="text-sm font-medium cursor-pointer"
                        >
                          {resource.name}
                        </label>
                        {resource.enabledByDefault && (
                          <Badge variant="info" className="text-xs">
                            Recommended
                          </Badge>
                        )}
                        {resource.ciType && (
                          <Badge variant="secondary" className="text-xs">
                            {resource.ciType}
                          </Badge>
                        )}
                      </div>
                      {resource.description && (
                        <p className="text-xs text-muted-foreground mb-2">
                          {resource.description}
                        </p>
                      )}

                      {/* Operations */}
                      {resource.operations && resource.operations.length > 0 && (
                        <div className="flex items-center gap-1 flex-wrap mb-2">
                          <span className="text-xs text-muted-foreground">Operations:</span>
                          {resource.operations.map((op) => (
                            <Badge key={op} variant="outline" className="text-xs">
                              {op}
                            </Badge>
                          ))}
                        </div>
                      )}

                      {/* Extraction Info */}
                      {resource.extraction && (
                        <div className="flex items-center gap-4 flex-wrap text-xs text-muted-foreground">
                          {resource.extraction.incremental && (
                            <div className="flex items-center gap-1">
                              <RefreshCw className="h-3 w-3" />
                              <span>Incremental</span>
                            </div>
                          )}
                          {resource.extraction.batchSize && (
                            <div className="flex items-center gap-1">
                              <Layers className="h-3 w-3" />
                              <span>Batch: {resource.extraction.batchSize}</span>
                            </div>
                          )}
                          {resource.extraction.rateLimit && (
                            <div className="flex items-center gap-1">
                              <Timer className="h-3 w-3" />
                              <span>Limit: {resource.extraction.rateLimit} req/s</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Dependencies Warning */}
                      {hasMissingDeps && (
                        <Alert variant="destructive" className="mt-2">
                          <AlertCircle className="h-4 w-4" />
                          <AlertDescription className="text-xs">
                            This resource requires:{' '}
                            {resource.extraction?.dependsOn
                              ?.filter((depId) => !selectedResources.includes(depId))
                              .map((depId) => resources.find((r) => r.id === depId)?.name)
                              .join(', ')}
                          </AlertDescription>
                        </Alert>
                      )}

                      {/* Dependencies Display */}
                      {showDependencies &&
                        resource.extraction?.dependsOn &&
                        resource.extraction.dependsOn.length > 0 && (
                          <div className="mt-2 p-2 bg-muted rounded-md">
                            <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                              <Link className="h-3 w-3" />
                              <span>Depends on:</span>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {resource.extraction.dependsOn.map((depId) => {
                                const depResource = resources.find((r) => r.id === depId);
                                const isDepEnabled = selectedResources.includes(depId);
                                return (
                                  <Badge
                                    key={depId}
                                    variant={isDepEnabled ? 'success' : 'outline'}
                                    className="text-xs"
                                  >
                                    {depResource?.name || depId}
                                  </Badge>
                                );
                              })}
                            </div>
                          </div>
                        )}

                      {/* Dependents Display */}
                      {showDependencies && isEnabled && dependents.length > 0 && (
                        <div className="mt-2 p-2 bg-muted rounded-md">
                          <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                            <Link className="h-3 w-3" />
                            <span>Required by:</span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {dependents.map((dep) => (
                              <Badge key={dep.id} variant="outline" className="text-xs">
                                {dep.name}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Resource Configuration */}
                      {isEnabled && hasConfig && (
                        <CollapsibleTrigger asChild>
                          <button className="mt-2 text-xs text-primary hover:underline">
                            {isExpanded ? 'Hide' : 'Show'} Configuration
                          </button>
                        </CollapsibleTrigger>
                      )}
                    </div>
                  </div>

                  {/* Configuration Form */}
                  {isEnabled && hasConfig && (
                    <CollapsibleContent className="pl-7">
                      <div className="mt-2 p-3 bg-muted rounded-md space-y-2">
                        <h4 className="text-xs font-medium mb-2">
                          Resource Configuration
                        </h4>
                        {/* TODO: Implement dynamic form based on configurationSchema */}
                        <div className="text-xs text-muted-foreground">
                          Configuration form for {resource.name} will be rendered here
                          based on schema
                        </div>
                      </div>
                    </CollapsibleContent>
                  )}
                </div>
              </Collapsible>
            </Card>
          );
        })}
      </div>

      {/* Summary */}
      <div className="flex items-center justify-between pt-2 border-t">
        <div className="text-sm text-muted-foreground">
          <strong>{selectedResources.length}</strong> of <strong>{resources.length}</strong>{' '}
          resources selected
        </div>
        {selectedResources.length > 0 && (
          <button
            onClick={() => onChange([], {})}
            className="text-sm text-destructive hover:underline"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
