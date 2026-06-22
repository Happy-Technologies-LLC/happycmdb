// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HealthMetrics Component
 * Time-series charts for CI health metrics (CPU, memory, disk usage)
 */

import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { useHealthMetrics } from '../../hooks/useAnalytics';
import { DateRangeSelector } from './DateRangeSelector';
import { ExportButton } from './ExportButton';
import { DateRangeParams } from '../../services/analytics.service';
import { brand } from '@/lib/brandColors';

export interface HealthMetricsProps {
  dateRange?: DateRangeParams;
}

export const HealthMetrics: React.FC<HealthMetricsProps> = ({ dateRange: externalDateRange }) => {
  const [ciId, setCiId] = useState<string>('');
  const [dateRange, setDateRange] = useState<DateRangeParams>({
    startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    endDate: new Date().toISOString(),
  });

  const effectiveDateRange = externalDateRange || dateRange;
  const { data, loading, error } = useHealthMetrics(ciId || null, effectiveDateRange);

  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours()}:${String(
      date.getMinutes()
    ).padStart(2, '0')}`;
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
              {entry.name}: {entry.value?.toFixed(1)}%
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  const renderContent = () => {
    if (!ciId) {
      return (
        <Alert className="h-[350px] flex items-center">
          <AlertDescription>Enter a CI ID to view health metrics</AlertDescription>
        </Alert>
      );
    }

    if (loading) {
      return (
        <div className="flex justify-center items-center h-[350px]">
          <Icon name="spinner-gap" size={32} className="animate-spin text-primary" />
        </div>
      );
    }

    if (error) {
      return (
        <Alert variant="destructive">
          <AlertDescription>Failed to load data</AlertDescription>
        </Alert>
      );
    }

    if (!data || data.length === 0) {
      return (
        <Alert>
          <AlertDescription>No health metrics available for this CI</AlertDescription>
        </Alert>
      );
    }

    const chartData = data.map((metric) => ({
      timestamp: formatTimestamp(metric.timestamp),
      fullTimestamp: metric.timestamp,
      CPU: metric.cpu_usage,
      Memory: metric.memory_usage,
      Disk: metric.disk_usage,
    }));

    return (
      <>
        <div className="flex justify-between items-center mb-4">
          <p className="text-sm text-muted-foreground font-medium">
            {data.length} data points
          </p>
          <ExportButton data={data} filename={`health_metrics_${ciId}`} />
        </div>

        <ResponsiveContainer width="100%" height={350}>
          <LineChart
            data={chartData}
            margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke={brand.line} />
            <XAxis
              dataKey="timestamp"
              tick={{ fill: brand.inkSoft, fontSize: 10 }}
            />
            <YAxis
              tick={{ fill: brand.inkSoft, fontSize: 12 }}
              domain={[0, 100]}
              label={{ value: 'Usage (%)', angle: -90, position: 'insideLeft' }}
            />
            <Tooltip content={<CustomTooltip />} />
            <Legend />
            <Line
              type="monotone"
              dataKey="CPU"
              stroke={brand.warning}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              type="monotone"
              dataKey="Memory"
              stroke={brand.sky}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              type="monotone"
              dataKey="Disk"
              stroke={brand.success}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </>
    );
  };

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle>CI Health Metrics</CardTitle>
      </CardHeader>

      <CardContent>
        <div className="mb-4">
          <Label htmlFor="ci-id">CI ID</Label>
          <Input
            id="ci-id"
            value={ciId}
            onChange={(e) => setCiId(e.target.value)}
            placeholder="Enter CI ID (e.g., server-001)"
          />
        </div>

        <DateRangeSelector onChange={setDateRange} />

        {renderContent()}
      </CardContent>
    </Card>
  );
};
