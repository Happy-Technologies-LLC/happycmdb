// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector Detail Modal
 * Displays comprehensive information about a connector including:
 * - Full description and metadata
 * - Version history with changelog
 * - Dependencies and requirements
 * - Installation statistics
 * - Installation/Update/Uninstall actions
 */

import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import {
  Download,
  Star,
  CheckCircle,
  ExternalLink,
  Package,
  Calendar,
  GitBranch,
  Shield,
  Users,
  FileText,
  Info,
  AlertTriangle,
  Trash2,
  RefreshCw,
} from 'lucide-react';
import { ConnectorRegistry } from '@/services/connector.service';
import { getConnectorIcon, getCategoryColor, getCategoryLabel } from '@/lib/connector-icons';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

interface ConnectorDetailModalProps {
  connector: ConnectorRegistry;
  installedVersion?: string;
  onClose: () => void;
  onInstall: () => void;
  onUninstall: (connectorType: string) => void;
}

export const ConnectorDetailModal: React.FC<ConnectorDetailModalProps> = ({
  connector,
  installedVersion,
  onClose,
  onInstall,
  onUninstall,
}) => {
  const [selectedTab, setSelectedTab] = useState('overview');
  const IconComponent = getConnectorIcon(
    (connector.metadata as any)?.icon || connector.connectorType
  );

  const isInstalled = !!installedVersion;
  const hasUpdate = installedVersion && installedVersion !== connector.latestVersion;

  // Infer category from metadata or connector type
  const displayCategory =
    (connector.metadata as any)?.connector_category ||
    connector.connectorType.toLowerCase();

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <DialogHeader>
          <div className="flex items-start gap-4">
            <div
              className={cn(
                'flex items-center justify-center w-16 h-16 rounded-xl',
                getCategoryColor(displayCategory),
                'bg-opacity-10'
              )}
            >
              <IconComponent className="w-10 h-10" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <DialogTitle className="text-2xl">{connector.name}</DialogTitle>
                {connector.verified && (
                  <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0" />
                )}
              </div>
              <DialogDescription className="text-base">
                {connector.description}
              </DialogDescription>
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <Badge variant="outline">{getCategoryLabel(displayCategory)}</Badge>
                <Badge variant="outline">v{connector.latestVersion}</Badge>
                {connector.license && (
                  <Badge variant="secondary">{connector.license}</Badge>
                )}
                {isInstalled && (
                  <Badge variant="default" className="bg-green-600">
                    Installed (v{installedVersion})
                  </Badge>
                )}
                {hasUpdate && (
                  <Badge variant="default" className="bg-orange-600">
                    Update Available
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </DialogHeader>

        <Separator className="my-4" />

        {/* Tabs */}
        <Tabs value={selectedTab} onValueChange={setSelectedTab} className="flex-1 overflow-hidden flex flex-col">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="versions">Versions</TabsTrigger>
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="stats">Stats</TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-y-auto mt-4">
            {/* Overview Tab */}
            <TabsContent value="overview" className="mt-0 space-y-4">
              {/* Quick Stats */}
              <div className="grid grid-cols-3 gap-4">
                <div className="flex items-center gap-3 p-4 border rounded-lg">
                  <Download className="h-5 w-5 text-blue-500" />
                  <div>
                    <div className="text-sm text-muted-foreground">Downloads</div>
                    <div className="text-lg font-semibold">
                      {connector.downloads.toLocaleString()}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-4 border rounded-lg">
                  <Star className="h-5 w-5 text-yellow-500 fill-yellow-500" />
                  <div>
                    <div className="text-sm text-muted-foreground">Rating</div>
                    <div className="text-lg font-semibold">
                      {connector.rating.toFixed(1)} / 5.0
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-4 border rounded-lg">
                  <GitBranch className="h-5 w-5 text-purple-500" />
                  <div>
                    <div className="text-sm text-muted-foreground">Versions</div>
                    <div className="text-lg font-semibold">{connector.versions.length}</div>
                  </div>
                </div>
              </div>

              {/* Tags */}
              {connector.tags && connector.tags.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                    <Package className="h-4 w-4" />
                    Tags
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {connector.tags.map(tag => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* Author Info */}
              {connector.author && (
                <div>
                  <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Author
                  </h4>
                  <p className="text-sm text-muted-foreground">{connector.author}</p>
                </div>
              )}

              {/* Links */}
              <div>
                <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                  <ExternalLink className="h-4 w-4" />
                  Links
                </h4>
                <div className="space-y-2">
                  {connector.homepage && (
                    <a
                      href={connector.homepage}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-sm text-blue-600 hover:underline"
                    >
                      <ExternalLink className="h-4 w-4" />
                      Homepage
                    </a>
                  )}
                  {connector.repository && (
                    <a
                      href={connector.repository}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-sm text-blue-600 hover:underline"
                    >
                      <GitBranch className="h-4 w-4" />
                      Repository
                    </a>
                  )}
                </div>
              </div>

              {/* Additional Metadata */}
              {connector.metadata && (
                <div>
                  <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                    <Info className="h-4 w-4" />
                    Additional Information
                  </h4>
                  <div className="space-y-2 text-sm">
                    {(connector.metadata as any).requirements && (
                      <div>
                        <span className="font-medium">Requirements:</span>{' '}
                        <span className="text-muted-foreground">
                          {(connector.metadata as any).requirements}
                        </span>
                      </div>
                    )}
                    {(connector.metadata as any).supported_platforms && (
                      <div>
                        <span className="font-medium">Platforms:</span>{' '}
                        <span className="text-muted-foreground">
                          {Array.isArray((connector.metadata as any).supported_platforms)
                            ? (connector.metadata as any).supported_platforms.join(', ')
                            : (connector.metadata as any).supported_platforms}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </TabsContent>

            {/* Versions Tab */}
            <TabsContent value="versions" className="mt-0 space-y-3">
              {connector.versions.map((version, index) => {
                const isLatest = index === 0;
                const isCurrent = version.version === installedVersion;

                return (
                  <div
                    key={version.version}
                    className={cn(
                      'p-4 border rounded-lg',
                      isCurrent && 'border-green-500 bg-green-50 dark:bg-green-900/10'
                    )}
                  >
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <h4 className="font-semibold">v{version.version}</h4>
                        {isLatest && (
                          <Badge variant="default" className="bg-blue-600">
                            Latest
                          </Badge>
                        )}
                        {isCurrent && (
                          <Badge variant="default" className="bg-green-600">
                            Installed
                          </Badge>
                        )}
                        {version.breakingChanges && (
                          <Badge variant="destructive">
                            <AlertTriangle className="h-3 w-3 mr-1" />
                            Breaking Changes
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Calendar className="h-4 w-4" />
                        {format(new Date(version.releasedAt), 'MMM d, yyyy')}
                      </div>
                    </div>

                    {version.changelog && (
                      <div className="mt-3">
                        <h5 className="text-xs font-semibold text-muted-foreground mb-2">
                          CHANGELOG
                        </h5>
                        <div className="text-sm whitespace-pre-wrap text-muted-foreground">
                          {version.changelog}
                        </div>
                      </div>
                    )}

                    {version.sizeBytes && (
                      <div className="mt-2 text-xs text-muted-foreground">
                        Size: {(version.sizeBytes / 1024 / 1024).toFixed(2)} MB
                      </div>
                    )}
                  </div>
                );
              })}
            </TabsContent>

            {/* Details Tab */}
            <TabsContent value="details" className="mt-0 space-y-4">
              <div>
                <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Connector Type
                </h4>
                <p className="text-sm text-muted-foreground font-mono bg-muted p-2 rounded">
                  {connector.connectorType}
                </p>
              </div>

              <div>
                <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                  <Package className="h-4 w-4" />
                  Category
                </h4>
                <p className="text-sm text-muted-foreground">{connector.category}</p>
              </div>

              {connector.license && (
                <div>
                  <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                    <Shield className="h-4 w-4" />
                    License
                  </h4>
                  <p className="text-sm text-muted-foreground">{connector.license}</p>
                </div>
              )}

              {connector.verified && (
                <div className="p-4 bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-800 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle className="h-5 w-5 text-green-600" />
                    <h4 className="font-semibold text-green-900 dark:text-green-100">
                      Verified Connector
                    </h4>
                  </div>
                  <p className="text-sm text-green-700 dark:text-green-300">
                    This connector has been verified by the HappyCMDB team and meets all
                    security and quality standards.
                  </p>
                </div>
              )}
            </TabsContent>

            {/* Stats Tab */}
            <TabsContent value="stats" className="mt-0">
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 border rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Download className="h-5 w-5 text-blue-500" />
                    <h4 className="font-semibold">Total Downloads</h4>
                  </div>
                  <div className="text-3xl font-bold">
                    {connector.downloads.toLocaleString()}
                  </div>
                </div>

                <div className="p-4 border rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Star className="h-5 w-5 text-yellow-500 fill-yellow-500" />
                    <h4 className="font-semibold">Average Rating</h4>
                  </div>
                  <div className="text-3xl font-bold">{connector.rating.toFixed(1)}</div>
                  <div className="text-sm text-muted-foreground">out of 5.0</div>
                </div>

                <div className="p-4 border rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <GitBranch className="h-5 w-5 text-purple-500" />
                    <h4 className="font-semibold">Available Versions</h4>
                  </div>
                  <div className="text-3xl font-bold">{connector.versions.length}</div>
                </div>

                <div className="p-4 border rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <Calendar className="h-5 w-5 text-green-500" />
                    <h4 className="font-semibold">Latest Release</h4>
                  </div>
                  <div className="text-lg font-semibold">
                    {connector.versions[0]?.releasedAt
                      ? format(new Date(connector.versions[0].releasedAt), 'MMM d, yyyy')
                      : 'N/A'}
                  </div>
                </div>
              </div>
            </TabsContent>
          </div>
        </Tabs>

        {/* Footer Actions */}
        <DialogFooter className="mt-4">
          {isInstalled ? (
            <>
              {hasUpdate && (
                <Button onClick={onInstall} variant="default">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Update to v{connector.latestVersion}
                </Button>
              )}
              <Button
                onClick={() => onUninstall(connector.connectorType)}
                variant="destructive"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Uninstall
              </Button>
            </>
          ) : (
            <Button onClick={onInstall} variant="default">
              <Download className="h-4 w-4 mr-2" />
              Install Connector
            </Button>
          )}
          <Button onClick={onClose} variant="outline">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
