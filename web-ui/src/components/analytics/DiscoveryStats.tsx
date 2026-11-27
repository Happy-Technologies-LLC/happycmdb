// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * DiscoveryStats Component
 * Discovery coverage statistics grouped by provider.
 */

import React from 'react';
import { SectionHeading } from '@happy-technologies/design-system';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { useDiscoveryStats } from '../../hooks/useAnalytics';
import { AnalyticsPanel, MetricCard } from './MetricCard';
import { DateRangeParams } from '../../services/analytics.service';
import { brand } from '@/lib/brandColors';

interface DiscoveryStatsProps {
  dateRange?: DateRangeParams;
}

export const DiscoveryStats: React.FC<DiscoveryStatsProps> = ({ dateRange }) => {
  const { data, loading, error, refetch } = useDiscoveryStats(dateRange);

  const chartData = (data?.by_provider ?? []).map((provider, index) => ({
    name: provider.discovery_provider,
    value: provider.count,
    color: [brand.sky, brand.success, brand.warning, brand.danger][index % 4],
  }));

  const CustomTooltip = ({
    active,
    payload,
  }: {
    active?: boolean;
    payload?: Array<{ name?: string; value?: number }>;
  }) => {
    if (active && payload?.length) {
      return (
        <div className="rounded-lg border bg-card p-3 shadow-md">
          <p className="text-sm font-semibold">{payload[0].name}</p>
          <p className="text-xs text-muted-foreground">
            {payload[0].value} discoveries
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <AnalyticsPanel
      title="Discovery Statistics"
      loading={loading}
      error={error}
      onRetry={refetch}
      empty={!data}
    >
      {() => data && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 mb-5">
            <MetricCard
              title="Discovered CIs"
              value={data.summary.total_cis}
              subtitle="Current configuration items"
            />
            <MetricCard
              title="CI Types"
              value={data.summary.unique_types}
              subtitle="Unique discovered types"
            />
            {data.summary.first_discovery && (
              <MetricCard
                title="First Discovery"
                value={new Date(data.summary.first_discovery).toLocaleString()}
              />
            )}
            {data.summary.last_discovery && (
              <MetricCard
                title="Last Discovery"
                value={new Date(data.summary.last_discovery).toLocaleString()}
              />
            )}
          </div>

          <div className="mt-5">
            <SectionHeading level={3}>Discoveries by Provider</SectionHeading>
            <ResponsiveContainer width="100%" height={250}>
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={90}
                  dataKey="value"
                  label={({ name, percent }) =>
                    `${name}: ${(percent * 100).toFixed(0)}%`
                  }
                >
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip />} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </AnalyticsPanel>
  );
};
