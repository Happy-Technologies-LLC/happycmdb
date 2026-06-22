// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ChangeTimeline Component
 * Timeline chart showing CI changes over time
 */

import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Icon } from '@happy-technologies/design-system';
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
  const { data, loading, error } = useChangeTimeline(effectiveDateRange);

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

  if (loading) {
    return (
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Change Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <DateRangeSelector onChange={setDateRange} />
          <div className="flex justify-center items-center h-[350px]">
            <Icon name="spinner-gap" size={32} className="animate-spin text-primary" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Change Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <DateRangeSelector onChange={setDateRange} />
          <Alert variant="destructive">
            <AlertDescription>Failed to load data</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  if (!data || data.length === 0) {
    return (
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Change Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <DateRangeSelector onChange={setDateRange} />
          <Alert>
            <AlertDescription>No changes in selected period</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const chartData = data.map((point) => ({
    date: formatDate(point.date),
    fullDate: point.date,
    Created: point.created,
    Updated: point.updated,
    Deleted: point.deleted,
  }));

  const totalChanges = data.reduce(
    (sum, point) => sum + point.created + point.updated + point.deleted,
    0
  );

  return (
    <Card className="mb-4">
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle>Change Timeline</CardTitle>
          <ExportButton data={data} filename="change_timeline" />
        </div>
      </CardHeader>

      <CardContent>
        <DateRangeSelector onChange={setDateRange} />

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
      </CardContent>
    </Card>
  );
};
