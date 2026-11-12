// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../../lib/api-client';
import type { HealthStatus } from '../../types';

// Live service-health -> dot colour. Unknown/missing -> neutral line, no live pulse. (The DS HealthDot has only
// up / down / checking: it cannot say "degraded" or "not probed", which the server reports.)
const STATUS_DOT: Record<HealthStatus['status'], string> = {
  healthy: 'bg-[var(--hh-success)]',
  degraded: 'bg-[var(--hh-warning)]',
  down: 'bg-[var(--hh-danger)]',
  unknown: 'bg-[var(--hh-border-strong)]',
};

function Dot({ label, title, service }: { label: string; title: string; service: HealthStatus | undefined }) {
  const status = service?.status ?? 'unknown';
  return (
    <span className="hh-display flex items-center gap-1.5 text-xs text-[var(--hh-text-body)]" title={`${title}: ${status}`}>
      <span
        className={`h-2 w-2 rounded-full ${STATUS_DOT[status]} ${status !== 'unknown' ? 'animate-[hh-pulse_2.4s_ease-in-out_infinite]' : ''}`}
      />
      {label}
    </span>
  );
}

/** F8: the Graph and Mart status dots, driven by the live /cmdb-health/services. */
export function ServiceHealthDots() {
  // Shares the ['service-health'] key (and cache) with HealthDashboard: one fetch feeds both.
  const { data: services } = useQuery({
    queryKey: ['service-health'],
    queryFn: () => apiClient.get<HealthStatus[]>('/cmdb-health/services'),
    refetchInterval: 10000,
  });
  return (
    <div className="hidden items-center gap-3.5 lg:flex">
      <Dot label="Graph" title="Neo4j graph" service={services?.find((s) => /neo4j|graph/i.test(s.service))} />
      <Dot label="Mart" title="Data mart" service={services?.find((s) => /mart|warehouse/i.test(s.service))} />
    </div>
  );
}
