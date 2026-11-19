/**
 * MetricCard Component
 * Reusable card for displaying key metrics with optional trend indicators, plus the AnalyticsPanel chrome the
 * analytics charts share (title, export slot, loading / failed / empty states).
 */

import React from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  Button,
  Card,
  EmptyState,
  MetricCard as DsMetricCard,
  SectionHeading,
} from '@happy-technologies/design-system';
import { classifyError } from '@/lib/estate';
import { isKnown, NOT_AVAILABLE } from '@/lib/dashboardValue';

export interface MetricCardProps {
  title: string;
  /** null or undefined means the figure is unavailable: the card says so instead of showing 0. */
  value: string | number | null | undefined;
  subtitle?: string;
  icon?: string;
  trend?: {
    value: number;
    direction: 'up' | 'down';
    isPositive?: boolean;
  };
  onPress?: () => void;
  loading?: boolean;
}

export const MetricCard: React.FC<MetricCardProps> = ({
  title,
  value,
  subtitle,
  icon,
  trend,
  onPress,
  loading = false,
}) => {
  let shown: string;
  if (typeof value === 'number') shown = isKnown(value) ? value.toLocaleString() : NOT_AVAILABLE;
  else shown = value ?? NOT_AVAILABLE;

  const good = trend ? (trend.isPositive ?? trend.direction === 'up') : false;
  const pressProps = onPress
    ? {
        role: 'button' as const,
        tabIndex: 0,
        onClick: onPress,
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onPress();
          }
        },
      }
    : {};

  return (
    <DsMetricCard
      {...pressProps}
      className="h-full"
      icon={icon}
      label={title}
      value={shown}
      sub={subtitle}
      loading={loading}
      annotation={
        trend
          ? {
              text: `${Math.abs(trend.value).toFixed(1)}%`,
              tone: good ? 'success' : 'danger',
              icon: trend.direction === 'up' ? 'trend-up' : 'trend-down',
            }
          : undefined
      }
    />
  );
};

export interface AnalyticsPanelProps {
  title: string;
  /** Header actions (an ExportButton). Shown only once the body has data. */
  actions?: ReactNode;
  /** Always shown above the body: a date range selector, a CI id field. */
  toolbar?: ReactNode;
  loading?: boolean;
  error?: Error | null;
  /** Called by the failed state's "Try again". */
  onRetry?: () => void;
  /** True when the read succeeded with nothing to show. */
  empty?: boolean;
  emptyLabel?: string;
  /** The body: only called when the read succeeded with data, so it may rely on that data. */
  children: () => ReactNode;
}

/**
 * One analytics panel. A refused read (403) says "Not permitted" and offers no retry; any other failure shows the
 * error and "Try again". An unavailable panel never shows a chart or a zero.
 */
export const AnalyticsPanel: React.FC<AnalyticsPanelProps> = ({
  title,
  actions,
  toolbar,
  loading = false,
  error = null,
  onRetry,
  empty = false,
  emptyLabel = 'No data available',
  children,
}) => {
  let body: ReactNode;
  let ready = false;
  if (loading) {
    body = <EmptyState loading label="Loading…" className="min-h-[200px]" />;
  } else if (error) {
    const failure = classifyError(error);
    const forbidden = failure.kind === 'forbidden';
    body = (
      <EmptyState
        tone="danger"
        icon={forbidden ? 'lock-key' : 'warning-circle'}
        title="Failed to load data"
        description={forbidden ? `Not permitted. ${failure.message}` : failure.message}
        action={
          !forbidden && onRetry ? (
            <Button variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      />
    );
  } else if (empty) {
    body = <EmptyState label={emptyLabel} />;
  } else {
    ready = true;
    body = children();
  }

  return (
    <Card as="section" aria-label={title} className="mb-4">
      <SectionHeading right={ready ? actions : undefined}>{title}</SectionHeading>
      {toolbar}
      {body}
    </Card>
  );
};
