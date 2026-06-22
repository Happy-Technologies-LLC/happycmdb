/**
 * MetricCard Component
 * Reusable card for displaying key metrics with optional trend indicators
 */

import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Icon } from '@happy-technologies/design-system';
import { cn } from '@/lib/utils';
import { brand } from '@/lib/brandColors';

export interface MetricCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: string;
  trend?: {
    value: number;
    direction: 'up' | 'down';
    isPositive?: boolean;
  };
  color?: string;
  onPress?: () => void;
  loading?: boolean;
}

export const MetricCard: React.FC<MetricCardProps> = ({
  title,
  value,
  subtitle,
  icon,
  trend,
  color = brand.sky,
  onPress,
  loading = false,
}) => {
  const getTrendColor = () => {
    if (!trend) return undefined;
    if (trend.isPositive !== undefined) {
      return trend.isPositive ? brand.success : brand.danger;
    }
    return trend.direction === 'up' ? brand.success : brand.danger;
  };

  const trendIconName = trend?.direction === 'up' ? 'trend-up' : 'trend-down';

  return (
    <Card
      className={cn(
        'h-full',
        onPress && 'cursor-pointer transition-all hover:shadow-lg hover:-translate-y-0.5'
      )}
      onClick={onPress}
    >
      <CardContent className="p-6">
        <div className="flex justify-between items-center mb-3">
          <p className="text-sm text-muted-foreground font-medium">
            {title}
          </p>
          {icon && (
            <div className="w-8 h-8 flex items-center justify-center">
              <Icon name={icon} size={24} />
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex justify-center items-center h-20">
            <Icon name="spinner-gap" size={24} className="animate-spin text-primary" />
          </div>
        ) : (
          <>
            <h4 className="text-3xl font-bold mb-2" style={{ color }}>
              {typeof value === 'number' ? value.toLocaleString() : value}
            </h4>

            {(subtitle || trend) && (
              <div className="flex justify-between items-center">
                {subtitle && (
                  <p className="text-xs text-muted-foreground">
                    {subtitle}
                  </p>
                )}
                {trend && (
                  <div className="flex items-center gap-1">
                    <Icon
                      name={trendIconName}
                      size={16}
                      style={{ color: getTrendColor() }}
                    />
                    <span
                      className="text-xs font-semibold"
                      style={{ color: getTrendColor() }}
                    >
                      {Math.abs(trend.value).toFixed(1)}%
                    </span>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
};
