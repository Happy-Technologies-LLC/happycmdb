// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Connector Detail Modal
 * Displays comprehensive information about a connector including:
 * - Full description and metadata
 * - Version history with changelog
 * - Dependencies and requirements
 * - Installation statistics
 * - Deployment and version information (connector code changes are offline)
 */

import React, { useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  Dialog,
  Icon,
  MetricCard,
  SectionHeading,
  Stat,
  TabPanel,
  Tabs,
} from '@happy-technologies/design-system';
import { ConnectorRegistry } from '@/services/connector.service';
import { getConnectorIcon, getCategoryLabel } from '@/lib/connector-icons';
import { safeExternalUrl } from '@/lib/safe-external-url';
import { categoryTileClass } from './ConnectorCard';
import { format } from 'date-fns';

interface ConnectorDetailModalProps {
  connector: ConnectorRegistry;
  installedVersion?: string;
  onClose: () => void;
}

const TABS_ID = 'connector-detail-tabs';
const TAB_OPTIONS = [
  { value: 'overview', label: 'Overview' },
  { value: 'versions', label: 'Versions' },
  { value: 'details', label: 'Details' },
  { value: 'stats', label: 'Stats' },
];

const SUBHEADING = 'mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--hh-text-primary)]';
const MUTED = 'text-sm text-[var(--hh-text-muted)]';
const LINK = 'inline-flex items-center gap-2 text-sm font-medium text-[var(--hh-accent-text)] hover:underline';

export const ConnectorDetailModal: React.FC<ConnectorDetailModalProps> = ({
  connector,
  installedVersion,
  onClose,
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

  // Manifest links are third-party data: only http(s) values become links.
  const homepageUrl = safeExternalUrl(connector.homepage);
  const repositoryUrl = safeExternalUrl(connector.repository);

  return (
    <Dialog
      open
      onClose={onClose}
      aria-label={connector.name}
      className="flex max-h-[90vh] max-w-4xl flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
        {/* Header */}
        <div className="flex items-start gap-4 pr-8">
          <div
            aria-hidden="true"
            className={`flex h-16 w-16 flex-none items-center justify-center rounded-xl ${categoryTileClass(displayCategory)}`}
          >
            <IconComponent size={40} />
          </div>
          <div className="min-w-0 flex-1">
            <SectionHeading level={2}>
              {connector.name}
              {connector.verified && (
                <span className="ml-2 inline-flex align-middle text-[var(--hh-success-text)]">
                  <Icon name="check-circle" size={20} />
                  <span className="sr-only">Verified</span>
                </span>
              )}
            </SectionHeading>
            <p className="text-base text-[var(--hh-text-muted)]">{connector.description}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge variant="neutral">{getCategoryLabel(displayCategory)}</Badge>
              <Badge variant="neutral">v{connector.latestVersion}</Badge>
              {connector.license && <Badge variant="default">{connector.license}</Badge>}
              {isInstalled && <Badge variant="success">Installed (v{installedVersion})</Badge>}
              {hasUpdate && <Badge variant="warning">Update Available</Badge>}
            </div>
          </div>
        </div>

        {/* Tabs */}
        <Tabs
          id={TABS_ID}
          aria-label="Connector details"
          value={selectedTab}
          onChange={setSelectedTab}
          options={TAB_OPTIONS}
        />

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Overview Tab */}
          <TabPanel tabsId={TABS_ID} value="overview" selected={selectedTab === 'overview'} className="space-y-4">
            {selectedTab === 'overview' && (
              <>
                {/* Quick Stats */}
                <div className="grid grid-cols-3 gap-4">
                  <Card>
                    <Stat align="left" size="sm" value={connector.downloads.toLocaleString()} label="Downloads" />
                  </Card>
                  <Card>
                    <Stat align="left" size="sm" value={`${connector.rating.toFixed(1)} / 5.0`} label="Rating" />
                  </Card>
                  <Card>
                    <Stat align="left" size="sm" value={connector.versions.length} label="Versions" />
                  </Card>
                </div>

                {/* Tags */}
                {connector.tags && connector.tags.length > 0 && (
                  <div>
                    <h4 className={SUBHEADING}>
                      <Icon name="package" size={16} />
                      Tags
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {connector.tags.map(tag => (
                        <Badge key={tag} variant="default">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {/* Author Info */}
                {connector.author && (
                  <div>
                    <h4 className={SUBHEADING}>
                      <Icon name="users" size={16} />
                      Author
                    </h4>
                    <p className={MUTED}>{connector.author}</p>
                  </div>
                )}

                {/* Links */}
                <div>
                  <h4 className={SUBHEADING}>
                    <Icon name="arrow-square-out" size={16} />
                    Links
                  </h4>
                  <div className="flex flex-col items-start gap-2">
                    {homepageUrl && (
                      <a
                        className={LINK}
                        href={homepageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Icon name="arrow-square-out" size={16} />
                        Homepage
                      </a>
                    )}
                    {repositoryUrl && (
                      <a
                        className={LINK}
                        href={repositoryUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <Icon name="git-branch" size={16} />
                        Repository
                      </a>
                    )}
                  </div>
                </div>

                {/* Additional Metadata */}
                {connector.metadata && (
                  <div>
                    <h4 className={SUBHEADING}>
                      <Icon name="info" size={16} />
                      Additional Information
                    </h4>
                    <div className="space-y-2 text-sm">
                      {(connector.metadata as any).requirements && (
                        <div>
                          <span className="font-medium">Requirements:</span>{' '}
                          <span className="text-[var(--hh-text-muted)]">
                            {(connector.metadata as any).requirements}
                          </span>
                        </div>
                      )}
                      {(connector.metadata as any).supported_platforms && (
                        <div>
                          <span className="font-medium">Platforms:</span>{' '}
                          <span className="text-[var(--hh-text-muted)]">
                            {Array.isArray((connector.metadata as any).supported_platforms)
                              ? (connector.metadata as any).supported_platforms.join(', ')
                              : (connector.metadata as any).supported_platforms}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </TabPanel>

          {/* Versions Tab */}
          <TabPanel tabsId={TABS_ID} value="versions" selected={selectedTab === 'versions'} className="space-y-3">
            {selectedTab === 'versions' &&
              connector.versions.map((version, index) => {
                const isLatest = index === 0;
                const isCurrent = version.version === installedVersion;

                return (
                  <Card key={version.version} className={isCurrent ? 'bg-[var(--hh-success-bg)]' : undefined}>
                    <div className="mb-2 flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <h4 className="font-semibold">v{version.version}</h4>
                        {isLatest && <Badge variant="info">Latest</Badge>}
                        {isCurrent && <Badge variant="success">Installed</Badge>}
                        {version.breakingChanges && (
                          <Badge variant="danger">
                            <Icon name="warning" size={12} />
                            Breaking Changes
                          </Badge>
                        )}
                      </div>
                      <div className={`flex items-center gap-2 ${MUTED}`}>
                        <Icon name="calendar" size={16} />
                        {format(new Date(version.releasedAt), 'MMM d, yyyy')}
                      </div>
                    </div>

                    {version.changelog && (
                      <div className="mt-3">
                        <h5 className="mb-2 text-xs font-semibold text-[var(--hh-text-muted)]">
                          CHANGELOG
                        </h5>
                        <div className={`whitespace-pre-wrap ${MUTED}`}>{version.changelog}</div>
                      </div>
                    )}

                    {version.sizeBytes && (
                      <div className="mt-2 text-xs text-[var(--hh-text-muted)]">
                        Size: {(version.sizeBytes / 1024 / 1024).toFixed(2)} MB
                      </div>
                    )}
                  </Card>
                );
              })}
          </TabPanel>

          {/* Details Tab */}
          <TabPanel tabsId={TABS_ID} value="details" selected={selectedTab === 'details'} className="space-y-4">
            {selectedTab === 'details' && (
              <>
                <div>
                  <h4 className={SUBHEADING}>
                    <Icon name="file-text" size={16} />
                    Connector Type
                  </h4>
                  <p className="rounded bg-[var(--hh-bg-elevated)] p-2 font-mono text-sm text-[var(--hh-text-muted)]">
                    {connector.connectorType}
                  </p>
                </div>

                <div>
                  <h4 className={SUBHEADING}>
                    <Icon name="package" size={16} />
                    Category
                  </h4>
                  <p className={MUTED}>{connector.category}</p>
                </div>

                {connector.license && (
                  <div>
                    <h4 className={SUBHEADING}>
                      <Icon name="shield" size={16} />
                      License
                    </h4>
                    <p className={MUTED}>{connector.license}</p>
                  </div>
                )}

                {connector.verified && (
                  <Banner tone="success" icon="check-circle">
                    <strong className="block font-semibold">Verified Connector</strong>
                    This connector has been verified by the HappyCMDB team and meets all
                    security and quality standards.
                  </Banner>
                )}
              </>
            )}
          </TabPanel>

          {/* Stats Tab */}
          <TabPanel tabsId={TABS_ID} value="stats" selected={selectedTab === 'stats'}>
            {selectedTab === 'stats' && (
              <div className="grid grid-cols-2 gap-4">
                <MetricCard
                  icon="download-simple"
                  tone="accent"
                  label="Total Downloads"
                  value={connector.downloads.toLocaleString()}
                />
                <MetricCard
                  icon="star"
                  tone="warning"
                  label="Average Rating"
                  value={connector.rating.toFixed(1)}
                  sub="out of 5.0"
                />
                <MetricCard
                  icon="git-branch"
                  tone="ai"
                  label="Available Versions"
                  value={connector.versions.length}
                />
                <MetricCard
                  icon="calendar"
                  tone="success"
                  label="Latest Release"
                  value={
                    connector.versions[0]?.releasedAt
                      ? format(new Date(connector.versions[0].releasedAt), 'MMM d, yyyy')
                      : 'N/A'
                  }
                />
              </div>
            )}
          </TabPanel>
        </div>

        {/* Connector code changes happen outside the application. */}
        <div className="flex items-center justify-end gap-3">
          <p className={`mr-auto ${MUTED}`}>
            Install and update connector code through deployment packaging.
          </p>
          <Button onClick={onClose} variant="secondary">
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
