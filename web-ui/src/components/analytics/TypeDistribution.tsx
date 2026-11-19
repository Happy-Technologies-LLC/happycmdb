// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * TypeDistribution Component
 * Pie/Donut chart showing CI distribution by type
 */

import React from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';
import { useCICountsByType } from '../../hooks/useAnalytics';
import { ExportButton } from './ExportButton';
import { AnalyticsPanel } from './MetricCard';
import { brand, chartSeries } from '@/lib/brandColors';

const COLORS = chartSeries;

export const TypeDistribution: React.FC = () => {
  const { data, loading, error, refetch } = useCICountsByType();

  const rows = data ?? [];

  const chartData = rows.map((item) => ({
    name: item.ci_type,
    value: item.count,
  }));

  const totalCIs = rows.reduce((sum, item) => sum + item.count, 0);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const percentage = ((payload[0].value / totalCIs) * 100).toFixed(1);
      return (
        <div className="rounded-lg border bg-card p-3 shadow-md">
          <p className="text-sm font-semibold">
            {payload[0].name}
          </p>
          <p className="text-xs text-muted-foreground">
            {payload[0].value.toLocaleString()} ({percentage}%)
          </p>
        </div>
      );
    }
    return null;
  };

  const renderLegend = (props: any) => {
    const { payload } = props;
    return (
      <div className="flex flex-wrap justify-center mt-5 gap-4">
        {payload.map((entry: any, index: number) => {
          const percentage = ((entry.payload.value / totalCIs) * 100).toFixed(1);
          return (
            <div key={`legend-${index}`} className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-xs">
                {entry.value}: {entry.payload.value.toLocaleString()} ({percentage}%)
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <AnalyticsPanel
      title="CI Distribution by Type"
      loading={loading}
      error={error}
      onRetry={refetch}
      empty={!data || data.length === 0}
      emptyLabel="No data available"
      actions={<ExportButton data={rows} filename="ci_distribution_by_type" />}
    >
      {() => (
        <>
          <p className="text-sm text-muted-foreground font-medium mb-4">
            Total CIs: {totalCIs.toLocaleString()}
          </p>

          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={chartData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={100}
                fill={brand.sky}
                dataKey="value"
                label={({ name, percent }) =>
                  `${name}: ${(percent * 100).toFixed(0)}%`
                }
              >
                {chartData.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={COLORS[index % COLORS.length]}
                  />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
              <Legend content={renderLegend} />
            </PieChart>
          </ResponsiveContainer>
        </>
      )}
    </AnalyticsPanel>
  );
};
