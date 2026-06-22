import React from 'react';
import { Icon } from '@happy-technologies/design-system';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Badge } from '@/components/ui/badge';

export interface KPICardProps {
  title: string;
  value: number | string;
  unit?: string;
  trend?: 'up' | 'down' | 'stable';
  trendValue?: number;
  icon?: string;
  color?: 'green' | 'red' | 'yellow' | 'blue' | 'purple';
  description?: string;
  onClick?: () => void;
}

const COLOR_CLASSES = {
  green: 'text-success bg-success-soft',
  red: 'text-danger bg-danger-soft',
  yellow: 'text-warning bg-warning-soft',
  blue: 'text-sky-text bg-sky-soft',
  purple: 'text-navy bg-sky-soft',
};

const ICON_COLOR_CLASSES = {
  green: 'text-success',
  red: 'text-danger',
  yellow: 'text-warning',
  blue: 'text-sky-text',
  purple: 'text-navy',
};

export const KPICard: React.FC<KPICardProps> = ({
  title,
  value,
  unit,
  trend,
  trendValue,
  icon,
  color = 'blue',
  description,
  onClick,
}) => {
  const getTrendIcon = () => {
    if (!trend) return null;
    if (trend === 'up') return <Icon name="trend-up" size={16} />;
    if (trend === 'down') return <Icon name="trend-down" size={16} />;
    return <Icon name="minus" size={16} />;
  };

  const getTrendColor = () => {
    if (!trend) return '';
    if (trend === 'up') return 'text-success';
    if (trend === 'down') return 'text-danger';
    return 'text-ink-soft';
  };

  const getVariant = () => {
    if (color === 'blue') return 'primary';
    if (color === 'green') return 'default';
    if (color === 'yellow' || color === 'red') return 'accent';
    if (color === 'purple') return 'secondary';
    return 'default';
  };

  return (
    <LiquidGlass
      variant={getVariant()}
      hover
      rounded="xl"
      className={onClick ? 'cursor-pointer' : ''}
      onClick={onClick}
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          {icon && (
            <Icon name={icon} size={20} className={`${ICON_COLOR_CLASSES[color]} opacity-60`} />
          )}
        </div>

        <div className="flex items-baseline gap-2">
          <div className="text-3xl font-bold">
            {typeof value === 'number' ? value.toLocaleString() : value}
          </div>
          {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
        </div>

        {(trend || description) && (
          <div className="flex items-center gap-2">
            {trend && (
              <Badge variant="outline" className={`flex items-center gap-1 ${getTrendColor()}`}>
                {getTrendIcon()}
                {trendValue !== undefined && (
                  <span className="text-xs">{trendValue > 0 ? '+' : ''}{trendValue}%</span>
                )}
              </Badge>
            )}
            {description && (
              <p className="text-xs text-muted-foreground">{description}</p>
            )}
          </div>
        )}
      </div>
    </LiquidGlass>
  );
};
