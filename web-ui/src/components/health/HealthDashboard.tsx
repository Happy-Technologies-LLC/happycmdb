import { LiquidGlass } from '@/components/ui/liquid-glass';
/** System liveness remains available; platform-wide aggregates are not tenant-scoped. */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../../lib/api-client';
import type { HealthStatus } from '../../types';
import { Icon } from '@happy-technologies/design-system';

export const HealthDashboard: React.FC = () => {
  const { data: services } = useQuery({
    queryKey: ['service-health'],
    queryFn: () => apiClient.get<HealthStatus[]>('/cmdb-health/services'),
    refetchInterval: 10000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">System Health Dashboard</h2>
        <p className="text-muted-foreground mt-1">Service availability</p>
      </div>
      <p role="status">Global health metrics and time-series are unavailable (platform operations only).</p>
      <LiquidGlass variant="default" rounded="xl">
        <h3 className="text-lg font-semibold mb-4">Service Health</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {services?.map((service) => (
            <div key={service.service} className="flex items-center justify-between p-4 border border-border rounded-lg">
              <div className="flex items-center gap-3">
                <Icon name={service.status === 'healthy' ? 'check-circle' : service.status === 'degraded' ? 'warning-circle' : 'x-circle'} size={20} />
                <div>
                  <div className="font-medium">{service.service}</div>
                  <div className="text-sm text-muted-foreground">{service.response_time_ms ? `${service.response_time_ms}ms` : 'N/A'}</div>
                </div>
              </div>
              <div className="text-sm text-muted-foreground">{new Date(service.last_check).toLocaleTimeString()}</div>
            </div>
          ))}
        </div>
      </LiquidGlass>
    </div>
  );
};
