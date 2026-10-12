// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/** ITIL record ownership is unavailable until HP1-S2; never render unscoped aggregates. */
export const ITSMDashboard = () => (
  <div className="p-6 space-y-6">
    <p className="text-sm text-muted-foreground">Dashboards · ITSM</p>
    <h1 className="text-[1.9rem]">ITSM Dashboard</h1>
    <p role="alert" className="rounded-lg border border-danger p-4 text-danger">
      ITIL incident and change records are temporarily unavailable pending tenant ownership in HP1-S2.
    </p>
  </div>
);

export default ITSMDashboard;
