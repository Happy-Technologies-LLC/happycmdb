import React from 'react';
import { DiscoveryProvider, DiscoveryStats } from '../../services/discovery.service';
import { LiquidGlass } from '../ui/liquid-glass';
import { Badge } from '../ui/badge';
import { Avatar, AvatarFallback } from '../ui/avatar';
import { Separator } from '../ui/separator';
import { Icon } from '@happy-technologies/design-system';
import { brand } from '@/lib/brandColors';

interface DiscoveryProviderCardProps {
  stats: DiscoveryStats;
}

const PROVIDER_CONFIG: Record<
  DiscoveryProvider,
  { name: string; color: string; icon: string }
> = {
  nmap: { name: 'Network Scan (Nmap)', color: brand.navy, icon: 'share-network' },
  ssh: { name: 'SSH Discovery', color: brand.success, icon: 'computer-tower' },
  'active-directory': { name: 'Active Directory', color: brand.sky, icon: 'users' },
  snmp: { name: 'SNMP Discovery', color: brand.danger, icon: 'pulse' },
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

const formatRelativeTime = (dateString?: string): string => {
  if (!dateString) return 'Never';
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
};

export const DiscoveryProviderCard: React.FC<DiscoveryProviderCardProps> = ({
  stats,
}) => {
  const config = PROVIDER_CONFIG[stats.provider];

  // Safety check: if provider not found in config, don't render
  if (!config) {
    console.warn(`Unknown discovery provider: ${stats.provider}. This provider may have been moved to Connectors.`);
    return null;
  }


  return (
    <LiquidGlass size="sm" rounded="xl" className={`h-full flex flex-col ${stats.enabled ? '' : 'opacity-70'}`}>
      {/* Header */}
      <div className="mb-4">
        <div className="flex justify-between items-start mb-4">
          <div className="flex items-center gap-3">
            <Avatar className="w-12 h-12" style={{ backgroundColor: config.color }}>
              <AvatarFallback>
                <Icon name={config.icon} size={24} className="text-white" />
              </AvatarFallback>
            </Avatar>
            <div>
              <h3 className="font-semibold">{config.name}</h3>
              <p className="text-xs text-muted-foreground">
                {stats.provider.toUpperCase()}
              </p>
            </div>
          </div>
          <Badge variant={stats.enabled ? 'secondary' : 'outline'}>
            {stats.enabled ? 'Enabled' : 'Disabled'}
          </Badge>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="flex-1">
        <div className="grid grid-cols-4 gap-4 mb-4">
          <div>
            <p className="text-2xl font-bold">{stats.totalJobs}</p>
            <p className="text-xs text-muted-foreground">Total Jobs</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-success">{stats.successfulJobs}</p>
            <p className="text-xs text-muted-foreground">Success</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-danger">{stats.failedJobs}</p>
            <p className="text-xs text-muted-foreground">Failed</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{stats.successRate.toFixed(0)}%</p>
            <p className="text-xs text-muted-foreground">Rate</p>
          </div>
        </div>

        <Separator className="my-4" />

        <div className="space-y-2">
          <div className="flex justify-between">
            <span className="text-sm text-muted-foreground">Discovered CIs:</span>
            <span className="text-sm font-medium">
              {stats.totalDiscoveredCIs.toLocaleString()}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-muted-foreground">Avg Duration:</span>
            <span className="text-sm font-medium">
              {formatDuration(stats.averageDuration)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-muted-foreground">Last Run:</span>
            <span className="text-sm font-medium">
              {formatRelativeTime(stats.lastRun)}
            </span>
          </div>
          {stats.nextScheduledRun && (
            <div className="flex justify-between">
              <span className="text-sm text-muted-foreground">Next Run:</span>
              <span className="text-sm font-medium text-primary">
                {formatRelativeTime(stats.nextScheduledRun)}
              </span>
            </div>
          )}
        </div>
      </div>

    </LiquidGlass>
  );
};

export default DiscoveryProviderCard;
