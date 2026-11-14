// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/services/api';
import dashboardService from '@/services/dashboard.service';
import { UnavailableNotice } from '@/components/dashboard/UnavailableNotice';
import { formatCount, isKnown, isUnavailable } from '@/lib/dashboardValue';

type RecordCount = { success: boolean; pagination: { total: number } };

/** Open-incident load: < 5 normal, 5-10 elevated, > 10 critical. Unknown is neutral, never a status colour. */
const incidentTone = (count: number | null): string => {
  if (!isKnown(count)) return 'text-muted-foreground';
  if (count > 10) return 'text-danger';
  return count >= 5 ? 'text-warning' : 'text-success';
};

export const ITSMDashboard = () => {
  // Incident and change totals come from the record routes guarded by HP1-S2
  // ownership predicates; the KPI aggregate below is a separate request.
  const { data, isPending, isError } = useQuery({
    queryKey: ['itil-record-counts'],
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
    queryKey: ['itsm-dashboard'],
    queryFn: () => dashboardService.getITSMDashboard(),
  });
  const kpi = kpis.data;
  // ciStatus is always computed from the graph: no 'active' group is a real 0.
  // Only a missing KPI response has no data (rendered as —).
  const activeCIs = kpi ? (kpi.ciStatus.find(group => group.status === 'active')?.count ?? 0) : null;

  return (
    <div className="p-6 space-y-6">
      <p className="text-sm text-muted-foreground">Dashboards · ITSM</p>
      <h1 className="text-[1.9rem]">ITSM Dashboard</h1>
      {isPending && <p role="status">Loading ITIL records…</p>}
      {isError && <p role="alert" className="rounded-lg border border-danger p-4 text-danger">
        ITIL records unavailable. No incident or change totals can be shown.
      </p>}
      {kpis.isError && <p role="alert" className="rounded-lg border border-danger p-4 text-danger">
        ITSM KPIs unavailable.
      </p>}
      {kpi && <section aria-label="ITSM KPIs" className="grid gap-4 md:grid-cols-3">
        <div>
          <p data-testid="kpi-open-incidents" className={`text-2xl font-bold ${incidentTone(kpi.openIncidentCount)}`}>
            {formatCount(kpi.openIncidentCount)}
          </p>
          <p className="text-xs text-muted-foreground">Open incidents</p>
        </div>
        <div>
          <p data-testid="kpi-changes-in-progress" className="text-2xl font-bold">
            {formatCount(kpi.changesInProgressCount)}
          </p>
          <p className="text-xs text-muted-foreground">Changes in progress</p>
        </div>
        <div>
          <p data-testid="kpi-active-cis" className="text-2xl font-bold">{formatCount(activeCIs)}</p>
          <p className="text-xs text-muted-foreground">Active CIs</p>
        </div>
      </section>}
      {kpi && isUnavailable(kpi.unavailable, 'slaCompliance') && <UnavailableNotice label="SLA compliance" />}
      {data && !isError && <div className="grid gap-4 md:grid-cols-2">
        <section><h2>Incidents</h2><p>{data.incidents}</p></section>
        <section><h2>Changes</h2><p>{data.changes}</p></section>
      </div>}
    </div>
  );
};

export default ITSMDashboard;
