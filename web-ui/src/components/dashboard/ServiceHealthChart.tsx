// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { AlertCircle } from 'lucide-react';
import { brand } from '@/lib/brandColors';

export interface HealthDataPoint {
  timestamp: string;
  healthScore: number;
  incidents?: number;
}

interface ServiceHealthChartProps {
  data: HealthDataPoint[];
  title?: string;
  description?: string;
  serviceName?: string;
  showIncidentMarkers?: boolean;
}

export const ServiceHealthChart: React.FC<ServiceHealthChartProps> = ({
  data,
  title = 'Service Health Over Time',
  description,
  serviceName,
  showIncidentMarkers = true,
}) => {
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-background border border-border p-3 rounded-lg shadow-lg">
          <p className="font-semibold mb-2">{label}</p>
          <p className="text-sm">
            Health Score: <span className="font-bold">{payload[0].value.toFixed(1)}%</span>
          </p>
          {payload[0].payload.incidents > 0 && (
            <p className="text-sm text-danger flex items-center gap-1 mt-1">
              <AlertCircle className="h-3 w-3" />
              {payload[0].payload.incidents} incident{payload[0].payload.incidents > 1 ? 's' : ''}
            </p>
          )}
        </div>
      );
    }
    return null;
  };

  const getHealthColor = (score: number) => {
    if (score >= 80) return brand.success;
    if (score >= 60) return brand.warning;
    return brand.danger;
  };

  const CustomDot = (props: any) => {
    const { cx, cy, payload } = props;
    if (showIncidentMarkers && payload.incidents > 0) {
      return (
        <g>
          <circle cx={cx} cy={cy} r={6} fill={brand.danger} stroke="#fff" strokeWidth={2} />
          <circle cx={cx} cy={cy} r={3} fill="#fff" />
        </g>
      );
    }
    return <circle cx={cx} cy={cy} r={4} fill={getHealthColor(payload.healthScore)} />;
  };

  return (
    <LiquidGlass variant="default" rounded="xl">
      <div>
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        {description && <p className="text-sm text-muted-foreground mb-4">{description}</p>}
        {serviceName && (
          <p className="text-sm text-muted-foreground mb-4">{serviceName}</p>
        )}
      
      
        <ResponsiveContainer width="100%" height={350}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
            <XAxis dataKey="timestamp" />
            <YAxis domain={[0, 100]} label={{ value: 'Health Score (%)', angle: -90, position: 'insideLeft' }} />
            <Tooltip content={<CustomTooltip />} />
            <Legend />
            <ReferenceLine y={80} stroke={brand.success} strokeDasharray="3 3" label="Good" />
            <ReferenceLine y={60} stroke={brand.warning} strokeDasharray="3 3" label="Warning" />
            <Line
              type="monotone"
              dataKey="healthScore"
              stroke={brand.sky}
              strokeWidth={2}
              name="Health Score"
              dot={<CustomDot />}
              activeDot={{ r: 8 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </LiquidGlass>
  );
};
