// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { MetricCard } from '@happy-technologies/design-system';
import type { DashboardStats } from '@/services/ci.service';
import { QueryState } from './SurfaceState';

/**
 * A KPI whose backend is not on main: no number, and the card names what is missing (decision N2 a). A zero or a
 * placeholder percentage would read as a measured value.
 */
function NotAvailable({ label, missing }: { label: string; missing: ReactNode }) {
  return (
    <MetricCard
      layout="compact"
      label={label}
      value="–"
      annotation={{ text: 'Not available yet', tone: 'neutral' }}
      sub={missing}
    />
  );
}

/**
 * ME9 to ME13, the KPI stack. CIs managed is real (`total_cis` of GET /analytics/dashboard). Health, drift and
 * coverage have no source yet, and the dashboard's `health_score` is a hardcoded 0 (analytics.controller.ts, BW4),
 * so it is not read. Deltas and sparklines need a KPI history (BW7) and are not drawn.
 */
export function EstateKpis({
  stats,
  loading,
  error,
  onRetry,
}: {
  stats?: DashboardStats;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  return (
    <div className="grid content-start gap-4">
      {error ? (
        <QueryState what="the estate counts" error={error} onRetry={onRetry} />
      ) : (
        <MetricCard
          layout="compact"
          label="CIs managed"
          loading={loading}
          value={stats ? stats.total_cis.toLocaleString('en-US') : '–'}
          sub={
            stats ? `${(stats.by_status.active ?? 0).toLocaleString('en-US')} active` : undefined
          }
        />
      )}
      <NotAvailable label="Health" missing="Needs a CI health state (BW1, BW4)" />
      <NotAvailable label="Config drift" missing="Needs a tenant-wide drift count (BW5)" />
      <NotAvailable label="Coverage" missing="Needs a coverage definition and metric (BW6)" />
    </div>
  );
}
