// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/services/api';

type RecordCount = { success: boolean; pagination: { total: number } };

export const ITSMDashboard = () => {
  // The legacy /dashboards/itsm aggregate is not an ITIL record authority.
  // Read only the record routes guarded by HP1-S2 ownership predicates.
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

  return (
    <div className="p-6 space-y-6">
      <p className="text-sm text-muted-foreground">Dashboards · ITSM</p>
      <h1 className="text-[1.9rem]">ITSM Dashboard</h1>
      {isPending && <p role="status">Loading ITIL records…</p>}
      {isError && <p role="alert" className="rounded-lg border border-danger p-4 text-danger">
        ITIL records unavailable. No incident or change totals can be shown.
      </p>}
      {data && !isError && <div className="grid gap-4 md:grid-cols-2">
        <section><h2>Incidents</h2><p>{data.incidents}</p></section>
        <section><h2>Changes</h2><p>{data.changes}</p></section>
      </div>}
    </div>
  );
};

export default ITSMDashboard;
