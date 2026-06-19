// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import {
  Treemap,
  ResponsiveContainer,
  Tooltip,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { brand, chartSeries } from '@/lib/brandColors';

export interface CostBreakdownItem {
  name: string;
  value: number;
  children?: CostBreakdownItem[];
  color?: string;
}

interface CostBreakdownChartProps {
  data: CostBreakdownItem[];
  title?: string;
  description?: string;
  type?: 'treemap' | 'pie';
  onItemClick?: (item: CostBreakdownItem) => void;
}

const COLORS = chartSeries;

export const CostBreakdownChart: React.FC<CostBreakdownChartProps> = ({
  data,
  title = 'Cost Breakdown',
  description = 'Cost allocation by category',
  type = 'treemap',
  onItemClick,
}) => {
  const formatCurrency = (value: number) => {
    if (value == null || isNaN(value)) return '$0';
    if (value >= 1000000) {
      return `$${(value / 1000000).toFixed(2)}M`;
    }
    if (value >= 1000) {
      return `$${(value / 1000).toFixed(0)}K`;
    }
    return `$${value.toFixed(0)}`;
  };

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-background border border-border p-3 rounded-lg shadow-lg">
          <p className="font-semibold">{data.name}</p>
          <p className="text-sm mt-1">Cost: {formatCurrency(data.value)}</p>
          {data.children && data.children.length > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {data.children.length} sub-categories
            </p>
          )}
        </div>
      );
    }
    return null;
  };

  const CustomTreemapContent = (props: any) => {
    const { x, y, width, height, name, value, depth } = props;

    if (width < 50 || height < 30) return null;

    return (
      <g>
        <rect
          x={x}
          y={y}
          width={width}
          height={height}
          style={{
            fill: depth < 2 ? props.fill : '#fff',
            stroke: '#fff',
            strokeWidth: 2,
            cursor: 'pointer',
          }}
        />
        {width > 100 && height > 50 && (
          <>
            <text
              x={x + width / 2}
              y={y + height / 2 - 10}
              textAnchor="middle"
              fill={depth < 2 ? '#fff' : '#000'}
              fontSize={14}
              fontWeight="bold"
            >
              {name}
            </text>
            <text
              x={x + width / 2}
              y={y + height / 2 + 10}
              textAnchor="middle"
              fill={depth < 2 ? '#fff' : '#000'}
              fontSize={12}
            >
              {formatCurrency(value)}
            </text>
          </>
        )}
      </g>
    );
  };

  if (type === 'pie') {
    return (
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-2">{title}</h3>
          {description && <p className="text-sm text-muted-foreground mb-4">{description}</p>}
        
        
          <ResponsiveContainer width="100%" height={400}>
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, percent }) =>
                  `${name}: ${(percent * 100).toFixed(1)}%`
                }
                outerRadius={150}
                fill={brand.sky}
                dataKey="value"
                onClick={(data) => onItemClick?.(data)}
              >
                {data.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={entry.color || COLORS[index % COLORS.length]}
                    style={{ cursor: 'pointer' }}
                  />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </LiquidGlass>
    );
  }

  return (
    <LiquidGlass variant="default" rounded="xl">
      <div>
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        {description && <p className="text-sm text-muted-foreground mb-4">{description}</p>}
      
      
        <ResponsiveContainer width="100%" height={400}>
          <Treemap
            data={data}
            dataKey="value"
            aspectRatio={4 / 3}
            stroke="#fff"
            fill={brand.sky}
            content={<CustomTreemapContent />}
            onClick={(data) => onItemClick?.(data)}
          >
            <Tooltip content={<CustomTooltip />} />
          </Treemap>
        </ResponsiveContainer>
      </div>
    </LiquidGlass>
  );
};
