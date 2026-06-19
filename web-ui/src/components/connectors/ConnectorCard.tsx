import React from 'react';
import { Download, Star, CheckCircle, ExternalLink } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConnectorRegistry } from '@/services/connector.service';
import { cn } from '@/lib/utils';
import { getConnectorIcon, getCategoryColor, getCategoryLabel } from '@/lib/connector-icons';

interface ConnectorCardProps {
  connector: ConnectorRegistry;
  onInstall: () => void;
  isInstalled?: boolean;
  installedVersion?: string;
}

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
  onInstall,
  isInstalled = false,
  installedVersion,
}: ConnectorCardProps) {
  const hasUpdate = installedVersion && installedVersion !== connector.latestVersion;

  // Extract category and icon from metadata if available
  const metadata = (connector as any).metadata;
  const connectorCategory = metadata?.connector_category || (connector as any).connector_category;
  const iconName = metadata?.icon || (connector as any).icon || connector.connectorType;
  const IconComponent = getConnectorIcon(iconName);

  // Determine display category (with intelligent fallback)
  const displayCategory = connectorCategory || inferCategoryFromType(connector.connectorType);

  return (
    <Card className="group hover:shadow-lg transition-all duration-200 p-6 relative overflow-hidden">
      {/* Category indicator bar */}
      <div
        className={cn(
          'absolute top-0 left-0 right-0 h-1',
          getCategoryColor(displayCategory)
        )}
      />

      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-2">
            <div className={cn(
              'flex items-center justify-center w-10 h-10 rounded-lg',
              getCategoryColor(displayCategory),
              'bg-opacity-10'
            )}>
              <IconComponent className={cn(
                'w-6 h-6',
                displayCategory === 'itsm' && 'text-sky-text',
                displayCategory === 'cloud' && 'text-navy',
                displayCategory === 'monitoring' && 'text-success',
                displayCategory === 'security' && 'text-danger'
              )} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-lg font-semibold truncate">{connector.name}</h3>
              {connector.verified && (
                <div className="flex items-center gap-1 mt-0.5">
                  <CheckCircle className="h-4 w-4 text-success flex-shrink-0" />
                  <span className="text-xs text-success">Verified</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap ml-13">
            <Badge variant="outline" className="text-xs">
              {getCategoryLabel(displayCategory)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              v{connector.latestVersion}
            </span>
            {connector.license && (
              <span className="text-xs text-muted-foreground">
                {connector.license}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Description */}
      <p className="text-sm text-muted-foreground mb-4 line-clamp-2">
        {connector.description}
      </p>

      {/* Tags */}
      {connector.tags && connector.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-4">
          {connector.tags.slice(0, 4).map((tag) => (
            <Badge key={tag} variant="secondary" className="text-xs">
              {tag}
            </Badge>
          ))}
          {connector.tags.length > 4 && (
            <Badge variant="secondary" className="text-xs">
              +{connector.tags.length - 4}
            </Badge>
          )}
        </div>
      )}

      {/* Stats */}
      <div className="flex items-center gap-4 mb-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-1">
          <Download className="h-4 w-4" />
          <span>{connector.downloads.toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-1">
          <Star className="h-4 w-4 fill-warning text-warning" />
          <span>{connector.rating.toFixed(1)}</span>
        </div>
      </div>

      {/* Author */}
      {connector.author && (
        <div className="mb-4 text-xs text-muted-foreground">
          by {connector.author}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        {isInstalled ? (
          <>
            <Badge variant="success" className="flex-1 justify-center">
              Installed {installedVersion && `(v${installedVersion})`}
            </Badge>
            {hasUpdate && (
              <Button
                size="sm"
                variant="outline"
                onClick={onInstall}
                className="flex-1"
              >
                Update Available
              </Button>
            )}
          </>
        ) : (
          <Button onClick={onInstall} className="flex-1" size="sm">
            Install
          </Button>
        )}
        {connector.homepage && (
          <Button
            size="sm"
            variant="ghost"
            className="px-2"
            onClick={(e) => {
              e.stopPropagation();
              window.open(connector.homepage, '_blank');
            }}
          >
            <ExternalLink className="h-4 w-4" />
          </Button>
        )}
      </div>
    </Card>
  );
}
