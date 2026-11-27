// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Analytics Page
 * Main analytics page with tabbed interface for different analytics views
 */

import React, { useState } from 'react';
import { PageHeader, TabPanel, Tabs } from '@happy-technologies/design-system';
import { InventoryStats } from '../components/analytics/InventoryStats';
import { ChangeTimeline } from '../components/analytics/ChangeTimeline';
import { HealthMetrics } from '../components/analytics/HealthMetrics';
import { TopConnectedCIs } from '../components/analytics/TopConnectedCIs';
import { RelationshipMatrix } from '../components/analytics/RelationshipMatrix';
import { DiscoveryStats } from '../components/analytics/DiscoveryStats';
import { DateRangeSelector } from '../components/analytics/DateRangeSelector';

const TABS = [
  { value: 'inventory', label: 'Inventory', icon: 'chart-bar' },
  { value: 'changes', label: 'Changes', icon: 'trend-up' },
  { value: 'health', label: 'Health', icon: 'pulse' },
  { value: 'connections', label: 'Connections', icon: 'share-network' },
  { value: 'relationships', label: 'Relationships', icon: 'git-branch' },
  { value: 'discovery', label: 'Discovery', icon: 'magnifying-glass' },
] as const;

type TabValue = (typeof TABS)[number]['value'];

export const Analytics: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabValue>('inventory');
  const [dateRange, setDateRange] = useState<{
    startDate?: string;
    endDate?: string;
  }>({});

  const handleDateRangeChange = (dateRange: { startDate?: string; endDate?: string }) => {
    setDateRange(dateRange);
  };

  return (
    <div>
      <PageHeader
        className="mb-6"
        eyebrow="Analytics"
        title="Analytics & Reporting"
        lede="Comprehensive insights into your CMDB configuration items"
        actions={<DateRangeSelector onChange={handleDateRangeChange} />}
      />

      <Tabs
        id="analytics-tabs"
        aria-label="Analytics views"
        className="mb-6"
        value={activeTab}
        onChange={setActiveTab}
        options={[...TABS]}
        collapseTo="select"
        collapseLabel="Analytics view"
      />

      {/* Only the selected view is mounted, as before: each view fetches its own data on mount. */}
      <TabPanel tabsId="analytics-tabs" value={activeTab} selected>
        {activeTab === 'inventory' && <InventoryStats />}
        {activeTab === 'changes' && <ChangeTimeline dateRange={dateRange} />}
        {activeTab === 'health' && <HealthMetrics dateRange={dateRange} />}
        {activeTab === 'connections' && <TopConnectedCIs />}
        {activeTab === 'relationships' && <RelationshipMatrix />}
        {activeTab === 'discovery' && <DiscoveryStats dateRange={dateRange} />}
      </TabPanel>
    </div>
  );
};

export default Analytics;
