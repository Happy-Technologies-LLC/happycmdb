// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { LiquidGlass } from '../ui/liquid-glass';

export const DiscoveryScheduleManager: React.FC = () => (
  <div className="space-y-4">
    <h3 className="text-lg font-semibold">Discovery Schedules</h3>
    <LiquidGlass size="sm" rounded="xl" className="p-6">
      <p className="font-semibold">Discovery schedules unavailable</p>
      <p className="text-sm text-muted-foreground">
        Global provider schedules cannot be viewed or edited. Organization-owned discovery definitions remain available in the Definitions tab.
      </p>
    </LiquidGlass>
  </div>
);

export default DiscoveryScheduleManager;
