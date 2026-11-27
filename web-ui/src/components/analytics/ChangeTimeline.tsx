// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ChangeTimeline Component
 * Timeline chart showing CI changes over time
 */

import React, { useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { useChangeTimeline } from '../../hooks/useAnalytics';
import { DateRangeSelector } from './DateRangeSelector';
import { ExportButton } from './ExportButton';
import { AnalyticsPanel } from './MetricCard';
import { DateRangeParams } from '../../services/analytics.service';
import { brand } from '@/lib/brandColors';

export interface ChangeTimelineProps {
  dateRange?: DateRangeParams;
}

export const ChangeTimeline: React.FC<ChangeTimelineProps> = ({ dateRange: externalDateRange }) => {
  const [dateRange, setDateRange] = useState<DateRangeParams>({
    startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    endDate: new Date().toISOString(),
  });

  const effectiveDateRange = externalDateRange || dateRange;
  const { data, loading, error, refetch } = useChangeTimeline(effectiveDateRange);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="rounded-lg border bg-card p-3 shadow-md">
          <p className="text-sm font-semibold mb-2">
            {label}
          </p>
          {payload.map((entry: any, index: number) => (
            <p
              key={index}
              className="text-xs block"
              style={{ color: entry.color }}
            >
              {entry.name}: {entry.value}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  const rows = data ?? [];

  const chartData = rows.map((point) => ({
    date: formatDate(point.date),
    fullDate: point.date,
    Created: point.created,
    Updated: point.updated,
    Deleted: point.deleted,
  }));

  const totalChanges = rows.reduce(
    (sum, point) => sum + point.created + point.updated + point.deleted,
    0
  );

  return (
    <AnalyticsPanel
      title="Change Timeline"
      toolbar={<DateRangeSelector onChange={setDateRange} />}
      loading={loading}
      error={error}
      onRetry={refetch}
      empty={rows.length === 0}
      emptyLabel="No changes in selected period"
      actions={<ExportButton data={rows} filename="change_timeline" />}
    >
      {() => (
        <>
          <p className="text-sm text-muted-foreground font-medium mb-4">
            Total Changes: {totalChanges.toLocaleString()}
          </p>

          <ResponsiveContainer width="100%" height={350}>
            <LineChart
              data={chartData}
              margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke={brand.line} />
              <XAxis
                dataKey="date"
                tick={{ fill: brand.inkSoft, fontSize: 12 }}
              />
              <YAxis tick={{ fill: brand.inkSoft, fontSize: 12 }} />
              <Tooltip content={<CustomTooltip />} />
              <Legend />
              <Line
                type="monotone"
                dataKey="Created"
                stroke={brand.success}
                strokeWidth={2}
                dot={{ r: 4 }}
                activeDot={{ r: 6 }}
              />
              <Line
                type="monotone"
                dataKey="Updated"
                stroke={brand.sky}
                strokeWidth={2}
                dot={{ r: 4 }}
                activeDot={{ r: 6 }}
              />
              <Line
                type="monotone"
                dataKey="Deleted"
                stroke={brand.danger}
                strokeWidth={2}
                dot={{ r: 4 }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </>
      )}
    </AnalyticsPanel>
  );
};
