// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * TopConnectedCIs Component
 * Horizontal bar chart showing most connected CIs
 */

import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Icon } from '@happy-technologies/design-system';
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
import { brand } from '@/lib/brandColors';

export const TopConnectedCIs: React.FC = () => {
  const { data, loading, error } = useTopConnectedCIs(10);

  if (loading) {
    return (
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Top Connected CIs</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex justify-center items-center h-[400px]">
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
          <CardTitle>Top Connected CIs</CardTitle>
        </CardHeader>
        <CardContent>
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
          <CardTitle>Top Connected CIs</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertDescription>No data available</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const chartData = data.map((item) => ({
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
    <Card className="mb-4">
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle>Top 10 Most Connected CIs</CardTitle>
          <ExportButton data={data} filename="top_connected_cis" />
        </div>
      </CardHeader>

      <CardContent>
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
      </CardContent>
    </Card>
  );
};
