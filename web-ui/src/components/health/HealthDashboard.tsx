/** System liveness remains available; platform-wide aggregates are not tenant-scoped. */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Banner,
  Card,
  EmptyState,
  Icon,
  PageHeader,
  SectionHeading,
  Skeleton,
  type BadgeVariant,
} from '@happy-technologies/design-system';
import { apiClient } from '../../lib/api-client';
import type { HealthStatus } from '../../types';
import { QueryState } from '../estate/SurfaceState';

/** Tone and text for each status: the label carries the meaning, the tone only reinforces it. */
const STATUS_BADGE: Record<HealthStatus['status'], { variant: BadgeVariant; label: string }> = {
  healthy: { variant: 'success', label: 'Healthy' },
  degraded: { variant: 'warning', label: 'Degraded' },
  down: { variant: 'danger', label: 'Down' },
  unknown: { variant: 'neutral', label: 'Unknown' },
};

export const HealthDashboard: React.FC = () => {
  const {
    data: services,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['service-health'],
    queryFn: () => apiClient.get<HealthStatus[]>('/cmdb-health/services'),
    refetchInterval: 10000,
  });

  let body: React.ReactNode;
  if (isLoading) {
    body = (
      <div aria-busy="true" className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[0, 1, 2].map((slot) => (
          <Skeleton key={slot} className="h-[74px]" />
        ))}
      </div>
    );
  } else if (error) {
    body = <QueryState what="service health" error={error} onRetry={() => void refetch()} />;
  } else if (!services || services.length === 0) {
    body = <EmptyState label="No services reported" />;
  } else {
    body = (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {services.map((service) => {
          const badge = STATUS_BADGE[service.status] ?? STATUS_BADGE.unknown;
          return (
            <Card key={service.service} inset="none" className="flex items-center justify-between gap-3 p-4">
              <div className="flex items-center gap-3">
                <Icon name={service.status === 'healthy' ? 'check-circle' : service.status === 'degraded' ? 'warning-circle' : service.status === 'unknown' ? 'question' : 'x-circle'} size={20} />
                <div>
                  <div className="font-medium">{service.service}</div>
                  <div className="text-sm text-[var(--hh-text-muted)]">{service.status === 'unknown' ? 'Not probed' : service.response_time_ms ? `${service.response_time_ms}ms` : 'N/A'}</div>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <Badge variant={badge.variant} dot>
                  {badge.label}
                </Badge>
                <div className="text-sm text-[var(--hh-text-muted)]">{new Date(service.last_check).toLocaleTimeString()}</div>
              </div>
            </Card>
          );
        })}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Operations" title="System Health Dashboard" lede="Service availability" />
      <Banner tone="info" icon="info" role="status">
        Global health metrics and time-series are unavailable (platform operations only).
      </Banner>
      <Card as="section" aria-label="Service Health">
        <SectionHeading>Service Health</SectionHeading>
        {body}
      </Card>
    </div>
  );
};
