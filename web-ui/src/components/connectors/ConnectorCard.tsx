import React from 'react';
import { Badge, Button, Card, Icon } from '@happy-technologies/design-system';
import { ConnectorRegistry } from '@/services/connector.service';
import { getConnectorIcon, getCategoryLabel } from '@/lib/connector-icons';

interface ConnectorCardProps {
  connector: ConnectorRegistry;
  isInstalled?: boolean;
  installedVersion?: string;
  /** Opens the connector's detail. The whole card is clickable and the name is its keyboard-reachable trigger. */
  onSelect?: () => void;
}

const TILE_TONE = {
  accent: 'bg-[var(--hh-accent-bg)] text-[var(--hh-accent-text)]',
  ai: 'bg-[var(--hh-indigo-bg)] text-[var(--hh-indigo-text)]',
  success: 'bg-[var(--hh-success-bg)] text-[var(--hh-success-text)]',
  danger: 'bg-[var(--hh-error-bg)] text-[var(--hh-error-text)]',
  warning: 'bg-[var(--hh-warning-bg)] text-[var(--hh-warning-text)]',
  neutral: 'bg-[var(--hh-bg-elevated)] text-[var(--hh-text-muted)]',
} as const;

const CATEGORY_TONE: Record<string, keyof typeof TILE_TONE> = {
  itsm: 'accent', 'asset-management': 'accent', ticketing: 'accent',
  cloud: 'ai', virtualization: 'ai', 'container-orchestration': 'ai',
  monitoring: 'success', backup: 'success',
  security: 'danger',
  identity: 'warning', 'endpoint-management': 'warning',
};

/** Classes for the tinted tile behind a connector's glyph; the category label always accompanies it. */
export const categoryTileClass = (category: string): string =>
  TILE_TONE[CATEGORY_TONE[category?.toLowerCase()] ?? 'neutral'];

// Helper function to infer category from connector type
const inferCategoryFromType = (connectorType: string): string => {
  const type = connectorType.toLowerCase();

  // ITSM / Ticketing
  if (['servicenow', 'jira', 'linear'].includes(type)) return 'itsm';

  // Cloud Providers
  if (['aws', 'azure', 'gcp', 'azure-ad', 'ibm-cloud', 'oracle-cloud'].includes(type)) return 'cloud';

  // Monitoring / Observability
  if (['datadog', 'prometheus', 'dynatrace', 'appdynamics', 'zabbix', 'lansweeper'].includes(type)) return 'monitoring';

  // Security
  if (['crowdstrike', 'wiz', 'tenable', 'prisma-cloud', 'defender'].includes(type)) return 'security';

  // Identity
  if (['okta', 'azure-ad'].includes(type)) return 'identity';

  // Endpoint Management
  if (['sccm', 'intune', 'jamf', 'tanium'].includes(type)) return 'endpoint-management';

  // Network
  if (['cisco-meraki', 'infoblox'].includes(type)) return 'network';

  // Storage
  if (['netapp', 'dell-emc'].includes(type)) return 'storage';

  // Backup
  if (['rubrik', 'veeam'].includes(type)) return 'backup';

  // Virtualization
  if (['vmware', 'proxmox', 'hyperv', 'nutanix'].includes(type)) return 'virtualization';

  // Container Orchestration
  if (['kubernetes', 'openshift', 'rancher', 'docker'].includes(type)) return 'container-orchestration';

  // Default fallback
  return 'custom';
};

export function ConnectorCard({
  connector,
  isInstalled = false,
  installedVersion,
  onSelect,
}: ConnectorCardProps) {

  // Extract category and icon from metadata if available
  const metadata = (connector as any).metadata;
  const connectorCategory = metadata?.connector_category || (connector as any).connector_category;
  const iconName = metadata?.icon || (connector as any).icon || connector.connectorType;
  const IconComponent = getConnectorIcon(iconName);

  // Determine display category (with intelligent fallback)
  const displayCategory = connectorCategory || inferCategoryFromType(connector.connectorType);

  return (
    <Card className={onSelect ? 'cursor-pointer' : undefined} onClick={onSelect}>
      {/* Header */}
      <div className="mb-4 flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-3">
            <div
              aria-hidden="true"
              className={`flex h-10 w-10 flex-none items-center justify-center rounded-lg ${categoryTileClass(displayCategory)}`}
            >
              <IconComponent size={24} />
            </div>
            <div className="min-w-0 flex-1">
              <div role="heading" aria-level={3} className="truncate text-lg font-semibold">
                {onSelect ? (
                  <Button variant="link" size="md" className="max-w-full truncate text-left">
                    {connector.name}
                  </Button>
                ) : (
                  connector.name
                )}
              </div>
              {connector.verified && (
                <Badge variant="success" className="mt-0.5">
                  <Icon name="check-circle" size={14} className="flex-shrink-0" />
                  Verified
                </Badge>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="neutral">{getCategoryLabel(displayCategory)}</Badge>
            <span className="text-xs text-[var(--hh-text-muted)]">v{connector.latestVersion}</span>
            {connector.license && (
              <span className="text-xs text-[var(--hh-text-muted)]">{connector.license}</span>
            )}
          </div>
        </div>
      </div>

      {/* Description */}
      <p className="mb-4 line-clamp-2 text-sm text-[var(--hh-text-muted)]">{connector.description}</p>

      {/* Tags */}
      {connector.tags && connector.tags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1">
          {connector.tags.slice(0, 4).map((tag) => (
            <Badge key={tag} variant="default">
              {tag}
            </Badge>
          ))}
          {connector.tags.length > 4 && <Badge variant="default">+{connector.tags.length - 4}</Badge>}
        </div>
      )}

      {/* Stats */}
      <div className="mb-4 flex items-center gap-4 text-sm text-[var(--hh-text-muted)]">
        <div className="flex items-center gap-1">
          <Icon name="download-simple" size={16} />
          <span>{connector.downloads.toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-1">
          <Icon name="star" size={16} />
          <span>{connector.rating.toFixed(1)}</span>
        </div>
      </div>

      {/* Author */}
      {connector.author && (
        <div className="mb-4 text-xs text-[var(--hh-text-muted)]">by {connector.author}</div>
      )}

      {/* Installation is managed by deployment packaging, not this application. */}
      <div className="flex items-center gap-2">
        {isInstalled ? (
          <Badge variant="success" className="flex-1 justify-center">
            Installed {installedVersion && `(v${installedVersion})`}
          </Badge>
        ) : (
          <Badge variant="neutral" className="flex-1 justify-center">
            Available for deployment
          </Badge>
        )}
        {connector.homepage && (
          <Button
            size="sm"
            variant="ghost"
            icon="arrow-square-out"
            onClick={(e) => {
              e.stopPropagation();
              window.open(connector.homepage, '_blank');
            }}
          >
            <span className="sr-only">{connector.name} homepage</span>
          </Button>
        )}
      </div>
    </Card>
  );
}
