// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Card, SectionHeading } from '@happy-technologies/design-system';

export const DiscoveryScheduleManager: React.FC = () => (
  <div className="space-y-4">
    <SectionHeading level={3}>Discovery Schedules</SectionHeading>
    <Card>
      <p className="font-semibold">Discovery schedules unavailable</p>
      <p className="text-sm text-[var(--hh-text-muted)]">
        Global provider schedules cannot be viewed or edited. Organization-owned discovery definitions remain available in the Definitions tab.
      </p>
    </Card>
  </div>
);

export default DiscoveryScheduleManager;
