// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * EnvironmentStats Component
 * Bar chart showing CI distribution by environment
 */

import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Loader2 } from 'lucide-react';
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
import { useCICountsByEnvironment } from '../../hooks/useAnalytics';
import { ExportButton } from './ExportButton';
import { brand } from '@/lib/brandColors';

const ENVIRONMENT_COLORS: Record<string, string> = {
  production: brand.danger,
  staging: brand.warning,
  development: brand.success,
  test: brand.sky,
};

export const EnvironmentStats: React.FC = () => {
  const { data, loading, error } = useCICountsByEnvironment();

  if (loading) {
    return (
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>CI Distribution by Environment</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex justify-center items-center h-[300px]">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="mb-4">
        <CardHeader>
          <CardTitle>CI Distribution by Environment</CardTitle>
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
          <CardTitle>CI Distribution by Environment</CardTitle>
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
    environment: item.environment,
    count: item.count,
  }));

  const totalCIs = data.reduce((sum, item) => sum + item.count, 0);

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const percentage = ((payload[0].value / totalCIs) * 100).toFixed(1);
      return (
        <div className="rounded-lg border bg-card p-3 shadow-md">
          <p className="text-sm font-semibold">
            {payload[0].payload.environment}
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
    <Card className="mb-4">
      <CardHeader>
        <div className="flex justify-between items-center">
          <CardTitle>CI Distribution by Environment</CardTitle>
          <ExportButton data={data} filename="ci_environment_stats" />
        </div>
      </CardHeader>

      <CardContent>
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
              dataKey="environment"
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
                  fill={ENVIRONMENT_COLORS[entry.environment] || brand.sky}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>

        <div className="flex flex-wrap justify-center mt-4 gap-4">
          {Object.entries(ENVIRONMENT_COLORS).map(([env, color]) => (
            <div key={env} className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span className="text-xs">
                {env.charAt(0).toUpperCase() + env.slice(1)}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
};
