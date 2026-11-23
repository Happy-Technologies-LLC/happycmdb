// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Banner, Button, Card, EmptyState, PageHeader } from '@happy-technologies/design-system';
import { apiClient } from '@/services/api';
import dashboardService from '@/services/dashboard.service';
import { useOrganizationId } from '@/contexts/OrganizationContext';
import { orgScopedKey } from '@/lib/queryKeys';
import { UnavailableNotice } from '@/components/dashboard/UnavailableNotice';
import { QueryState } from '@/components/estate/SurfaceState';
import { classifyError } from '@/lib/estate';
import { DashboardSection } from './dashboardChrome';
import { formatCount, isKnown, isUnavailable } from '@/lib/dashboardValue';

type RecordCount = { success: boolean; pagination: { total: number } };

/** Open-incident load: < 5 normal, 5-10 elevated, > 10 critical. Unknown is neutral, never a status colour. */
const incidentTone = (count: number | null): string => {
  if (!isKnown(count)) return 'text-muted-foreground';
  if (count > 10) return 'text-danger';
  return count >= 5 ? 'text-warning' : 'text-success';
};

/** A refused read gets the shared "no access" state with the server's reason; any other failure a retryable banner. */
const ReadFailure = ({ what, error, onRetry, children }: {
  what: string; error: unknown; onRetry: () => void; children: ReactNode;
}) => classifyError(error).kind === 'forbidden'
  ? <QueryState what={what} error={error} />
  : (
    <Banner tone="danger" icon="warning-circle">
      {children}
      <Button size="sm" variant="secondary" className="ml-3" onClick={onRetry}>Try again</Button>
    </Banner>
  );

export const ITSMDashboard = () => {
  const organizationId = useOrganizationId();
  // Incident and change totals come from the record routes guarded by HP1-S2
  // ownership predicates; the KPI aggregate below is a separate request.
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: orgScopedKey('itil-record-counts', organizationId),
    queryFn: async () => {
      const [incidents, changes] = await Promise.all([
        apiClient.get<RecordCount>('/itil/incidents', { params: { limit: 1 } }),
        apiClient.get<RecordCount>('/itil/changes', { params: { limit: 1 } }),
      ]);
      return { incidents: incidents.data.pagination.total, changes: changes.data.pagination.total };
    },
  });

  // KPIs are computed server-side from the caller's organization; null means no backing data.
  const kpis = useQuery({
    queryKey: orgScopedKey('itsm-dashboard', organizationId),
    queryFn: () => dashboardService.getITSMDashboard(),
  });
  const kpi = kpis.data;
  // ciStatus is always computed from the graph: no 'active' group is a real 0.
  // Only a missing KPI response has no data (rendered as —).
  const activeCIs = kpi ? (kpi.ciStatus.find(group => group.status === 'active')?.count ?? 0) : null;

  return (
    <div className="p-6 space-y-6">
      <PageHeader eyebrow="Dashboards · ITSM" title="ITSM Dashboard" />
      {isPending && <EmptyState loading label="Loading ITIL records…" />}
      {isError && (
        <ReadFailure what="ITIL records" error={error} onRetry={() => refetch()}>
          ITIL records unavailable. No incident or change totals can be shown.
        </ReadFailure>
      )}
      {kpis.isError && (
        <ReadFailure what="ITSM KPIs" error={kpis.error} onRetry={() => kpis.refetch()}>
          ITSM KPIs unavailable.
        </ReadFailure>
      )}
      {kpi && <section aria-label="ITSM KPIs" className="grid gap-4 md:grid-cols-3">
        <Card>
          <p data-testid="kpi-open-incidents" className={`text-2xl font-bold ${incidentTone(kpi.openIncidentCount)}`}>
            {formatCount(kpi.openIncidentCount)}
          </p>
          <p className="text-xs text-muted-foreground">Open incidents</p>
        </Card>
        <Card>
          <p data-testid="kpi-changes-in-progress" className="text-2xl font-bold">
            {formatCount(kpi.changesInProgressCount)}
          </p>
          <p className="text-xs text-muted-foreground">Changes in progress</p>
        </Card>
        <Card>
          <p data-testid="kpi-active-cis" className="text-2xl font-bold">{formatCount(activeCIs)}</p>
          <p className="text-xs text-muted-foreground">Active CIs</p>
        </Card>
      </section>}
      {kpi && isUnavailable(kpi.unavailable, 'slaCompliance') && <UnavailableNotice label="SLA compliance" />}
      {data && !isError && <div className="grid gap-4 md:grid-cols-2">
        <DashboardSection title="Incidents"><p className="text-2xl font-bold">{formatCount(data.incidents)}</p></DashboardSection>
        <DashboardSection title="Changes"><p className="text-2xl font-bold">{formatCount(data.changes)}</p></DashboardSection>
      </div>}
    </div>
  );
};

export default ITSMDashboard;
