// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * StatusBreakdown Component
 * Bar chart showing CI distribution by status
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
  Cell,
} from 'recharts';
import { useCICountsByStatus } from '../../hooks/useAnalytics';
import { ExportButton } from './ExportButton';
import { AnalyticsPanel } from './MetricCard';
import { brand } from '@/lib/brandColors';

const STATUS_COLORS: Record<string, string> = {
  active: brand.success,
  inactive: brand.inkSoft,
  maintenance: brand.warning,
  decommissioned: brand.danger,
};

export const StatusBreakdown: React.FC = () => {
  const { data, loading, error, refetch } = useCICountsByStatus();

  const rows = data ?? [];

  const chartData = rows.map((item) => ({
    status: item.status,
    count: item.count,
  }));

  const totalCIs = rows.reduce((sum, item) => sum + item.count, 0);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const percentage = ((payload[0].value / totalCIs) * 100).toFixed(1);
      return (
        <div className="rounded-lg border bg-card p-3 shadow-md">
          <p className="text-sm font-semibold">
            {payload[0].payload.status}
          </p>
          <p className="text-xs text-muted-foreground">
            Count: {payload[0].value.toLocaleString()} ({percentage}%)
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <AnalyticsPanel
      title="CI Status Breakdown"
      loading={loading}
      error={error}
      onRetry={refetch}
      empty={!data || data.length === 0}
      emptyLabel="No data available"
      actions={<ExportButton data={rows} filename="ci_status_breakdown" />}
    >
      {() => (
        <>
          <p className="text-sm text-muted-foreground font-medium mb-4">
            Total CIs: {totalCIs.toLocaleString()}
          </p>

          <ResponsiveContainer width="100%" height={300}>
            <BarChart
              data={chartData}
              margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={brand.line} />
              <XAxis
                dataKey="status"
                tick={{ fill: brand.inkSoft, fontSize: 12 }}
                tickFormatter={(value) =>
                  value.charAt(0).toUpperCase() + value.slice(1)
                }
              />
              <YAxis tick={{ fill: brand.inkSoft, fontSize: 12 }} />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: brand.warmAlt }} />
              <Bar dataKey="count" radius={[8, 8, 0, 0]}>
                {chartData.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={STATUS_COLORS[entry.status] || brand.sky}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>

          <div className="flex flex-wrap justify-center mt-4 gap-4">
            {Object.entries(STATUS_COLORS).map(([status, color]) => (
              <div key={status} className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span className="text-xs">
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </AnalyticsPanel>
  );
};
