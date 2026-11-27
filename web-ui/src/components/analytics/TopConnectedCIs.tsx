// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * TopConnectedCIs Component
 * Horizontal bar chart showing most connected CIs
 */

import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { useTopConnectedCIs } from '../../hooks/useAnalytics';
import { ExportButton } from './ExportButton';
import { AnalyticsPanel } from './MetricCard';
import { brand } from '@/lib/brandColors';

export const TopConnectedCIs: React.FC = () => {
  const { data, loading, error, refetch } = useTopConnectedCIs(10);

  const rows = data ?? [];

  const chartData = rows.map((item) => ({
    name: item.ci_name,
    type: item.ci_type,
    connections: item.connection_count,
  }));

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="rounded-lg border bg-card p-3 shadow-md">
          <p className="text-sm font-semibold">
            {payload[0].payload.name}
          </p>
          <p className="text-xs text-muted-foreground block">
            {payload[0].payload.type}
          </p>
          <p className="text-xs text-primary font-semibold">
            Connections: {payload[0].value}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <AnalyticsPanel
      title="Top 10 Most Connected CIs"
      loading={loading}
      error={error}
      onRetry={refetch}
      empty={!data || data.length === 0}
      emptyLabel="No data available"
      actions={<ExportButton data={rows} filename="top_connected_cis" />}
    >
      {() => (
        <>
          <ResponsiveContainer width="100%" height={400}>
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 20, right: 30, left: 150, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={brand.line} />
              <XAxis type="number" tick={{ fill: brand.inkSoft, fontSize: 12 }} />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fill: brand.inkSoft, fontSize: 12 }}
                width={140}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: brand.warmAlt }} />
              <Bar dataKey="connections" fill={brand.sky} radius={[0, 8, 8, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </>
      )}
    </AnalyticsPanel>
  );
};
