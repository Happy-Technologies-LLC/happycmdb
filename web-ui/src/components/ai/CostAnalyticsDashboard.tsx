// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { Button, Card, EmptyState, Icon, MetricCard, SectionHeading, Select } from '@happy-technologies/design-system';
import { useDiscoverySessions } from '@/hooks/useDiscoverySessions';
import { QueryState } from '@/components/estate/SurfaceState';
import { EMPTY_VALUE, NOT_AVAILABLE, formatCount, formatPercent, isKnown } from '@/lib/dashboardValue';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { brand, chartSeries } from '@/lib/brandColors';
import { readFailure, useReadRefusal } from './readState';

const RANGE_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

const TOOLTIP_STYLE = {
  backgroundColor: 'var(--hh-card)',
  border: '1px solid var(--hh-border)',
  borderRadius: '8px',
};

/** ISO bounds of the last `days` days, ending now. */
function rangeBounds(days: number): { dateFrom: string; dateTo: string } {
  return {
    dateTo: new Date().toISOString(),
    dateFrom: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
  };
}

/** A money figure: unknown (null, undefined, NaN) is unavailable, never $0. A real 0 is $0.00. */
const money = (value: number | null | undefined, digits: number): string | null =>
  isKnown(value) ? `$${value.toFixed(digits)}` : null;

export const CostAnalyticsDashboard: React.FC = () => {
  const { costAnalytics, loadCostAnalytics, loading } = useDiscoverySessions();
  const refusal = useReadRefusal();
  const [dateRange, setDateRange] = useState<string>('30');

  useEffect(() => {
    const { dateFrom, dateTo } = rangeBounds(parseInt(dateRange));
    loadCostAnalytics(dateFrom, dateTo);
  }, [dateRange, loadCostAnalytics]);

  if (loading) {
    return <QueryState what="cost analytics" loading />;
  }

  if (!costAnalytics) {
    // The hook reports a failed cost read as a toast and keeps no error, so only a refusal is told apart here.
    if (refusal !== null) return <QueryState what="cost analytics" error={readFailure(null, refusal)} />;
    return (
      <EmptyState
        icon="currency-dollar"
        title="No cost data available"
        action={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              const { dateFrom, dateTo } = rangeBounds(parseInt(dateRange));
              void loadCostAnalytics(dateFrom, dateTo);
            }}
          >
            Try again
          </Button>
        }
      />
    );
  }

  // Prepare chart data (an unknown figure is a gap, not 0)
  const costTrendData = costAnalytics.costByDay?.map(day => ({
    date: new Date(`${day.date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    cost: isKnown(day.cost) ? parseFloat(day.cost.toFixed(4)) : null,
    sessions: day.sessions,
  })) || [];

  const modelData = costAnalytics.costByModel?.map(model => ({
    name: model.aiModel,
    cost: isKnown(model.cost) ? parseFloat(model.cost.toFixed(4)) : null,
    sessions: model.sessions,
  })) || [];
  const pricedModels = modelData.filter(model => model.cost !== null);

  const COLORS = chartSeries;

  const savings = costAnalytics.savingsFromPatterns;
  const totalCost = money(costAnalytics.totalCost, 2);
  const avgCost = money(costAnalytics.avgCostPerSession, 4);
  const totalSaved = money(savings?.totalSaved, 2);
  const unavailable = { value: EMPTY_VALUE, valueClass: 'text-[var(--hh-text-muted)]', sub: NOT_AVAILABLE };

  return (
    <div className="space-y-6">
      {/* Date Range Selector */}
      <SectionHeading
        level={3}
        right={
          <Select
            size="sm"
            aria-label="Date range"
            value={dateRange}
            onChange={setDateRange}
            options={RANGE_OPTIONS}
            containerClassName="w-[180px]"
          />
        }
      >
        Cost Analytics
      </SectionHeading>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
        <MetricCard
          layout="compact"
          label="Total Cost"
          {...(totalCost === null
            ? unavailable
            : {
                value: totalCost,
                sub: isKnown(costAnalytics.totalSessions) ? `${costAnalytics.totalSessions} sessions` : undefined,
              })}
        />

        <MetricCard
          layout="compact"
          label="Avg Cost/Session"
          {...(avgCost === null ? unavailable : { value: avgCost })}
        />

        <MetricCard
          layout="compact"
          label="Savings"
          {...(totalSaved === null ? unavailable : { value: totalSaved, valueClass: 'text-[var(--hh-success-text)]' })}
          annotation={
            isKnown(savings?.percentSaved)
              ? { text: `${savings.percentSaved.toFixed(0)}% saved`, tone: 'success', icon: 'lightning' }
              : undefined
          }
        />

        <Card inset="none" className="flex min-h-[125px] flex-col justify-between px-[18px] pt-[15px] pb-3.5">
          <span className="text-[12.5px] font-semibold text-[var(--hh-text-body)]">Pattern Efficiency</span>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--hh-text-muted)]">Pattern hits</span>
              <span className="font-semibold">{formatCount(savings?.patternHits)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--hh-text-muted)]">AI discoveries</span>
              <span className="font-semibold">{formatCount(savings?.aiDiscoveries)}</span>
            </div>
          </div>
        </Card>
      </div>

      {/* Charts Row 1 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Cost Trend */}
        <Card className="overflow-hidden">
          <SectionHeading level={3}>Cost Trend</SectionHeading>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={costTrendData}>
              <defs>
                <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={brand.sky} stopOpacity={0.3}/>
                  <stop offset="95%" stopColor={brand.sky} stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
              <XAxis dataKey="date" stroke="currentColor" opacity={0.5} fontSize={12} />
              <YAxis stroke="currentColor" opacity={0.5} fontSize={12} tickFormatter={(value) => `$${value}`} />
              <Tooltip
                contentStyle={TOOLTIP_STYLE}
                formatter={(value: number) => [money(value, 4) ?? EMPTY_VALUE, 'Cost']}
              />
              <Area type="monotone" dataKey="cost" stroke={brand.sky} fillOpacity={1} fill="url(#costGradient)" />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        {/* Session Volume */}
        <Card className="overflow-hidden">
          <SectionHeading level={3}>Session Volume</SectionHeading>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={costTrendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
              <XAxis dataKey="date" stroke="currentColor" opacity={0.5} fontSize={12} />
              <YAxis stroke="currentColor" opacity={0.5} fontSize={12} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="sessions" fill={brand.navy} radius={[8, 8, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Charts Row 2 */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Cost by Model */}
        <Card className="overflow-hidden">
          <SectionHeading level={3}>Cost by Model</SectionHeading>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={pricedModels} cx="50%" cy="50%" labelLine={false} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} outerRadius={100} fill={brand.sky} dataKey="cost">
                {pricedModels.map((_entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(value: number) => money(value, 4) ?? EMPTY_VALUE}
                contentStyle={TOOLTIP_STYLE}
              />
            </PieChart>
          </ResponsiveContainer>
        </Card>

        {/* Model Stats Table */}
        <Card className="overflow-hidden">
          <SectionHeading level={3}>Model Statistics</SectionHeading>
          <div className="space-y-3">
            {modelData.map((model, index) => (
              <Card key={model.name} inset="none" className="flex items-center justify-between p-3">
                <div className="flex items-center gap-3">
                  <div
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: COLORS[index % COLORS.length] }}
                  />
                  <div>
                    <p className="font-semibold">{model.name}</p>
                    <p className="text-xs text-[var(--hh-text-muted)]">
                      {model.sessions} sessions
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-bold">{money(model.cost, 4) ?? NOT_AVAILABLE}</p>
                  {isKnown(model.cost) && model.sessions > 0 && (
                    <p className="text-xs text-[var(--hh-text-muted)]">
                      ${(model.cost / model.sessions).toFixed(4)}/session
                    </p>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </Card>
      </div>

      {/* Savings Breakdown */}
      {isKnown(savings?.totalSaved) && savings.totalSaved > 0 && (
        <Card className="overflow-hidden">
          <SectionHeading level={3}>
            <span className="flex items-center gap-2">
              <Icon name="lightning" size={20} />
              Pattern Learning Impact
            </span>
          </SectionHeading>
          <div className="grid grid-cols-1 gap-6 text-center md:grid-cols-4">
            {[
              ['Total Saved', `${savings.totalSaved.toFixed(2)}`, 'text-[var(--hh-success-text)]'],
              ['Cost Reduction', formatPercent(savings.percentSaved, 0), 'text-[var(--hh-accent-text)]'],
              ['Pattern Matches', formatCount(savings.patternHits), ''],
              ['AI Discoveries', formatCount(savings.aiDiscoveries), 'text-[var(--hh-warning-text)]'],
            ].map(([label, value, tone]) => (
              <div key={label}>
                <p className={`text-3xl font-bold ${tone}`}>{value}</p>
                <p className="mt-1 text-sm text-[var(--hh-text-muted)]">{label}</p>
              </div>
            ))}
          </div>

          {isKnown(savings.percentSaved) && (
            <div className="mt-6 flex items-start gap-3 rounded-[var(--hh-radius-lg)] bg-[var(--hh-success-bg)] p-4">
              <Icon name="trend-down" size={20} className="mt-0.5 text-[var(--hh-success-text)]" />
              <div>
                <p className="font-semibold text-[var(--hh-success-text)]">
                  Pattern Learning is Saving You Money
                </p>
                <p className="mt-1 text-sm text-[var(--hh-text-muted)]">
                  By automatically learning patterns from AI discoveries, you're reducing discovery costs
                  by {savings.percentSaved.toFixed(0)}%. Pattern matches complete
                  in &lt;1 second with $0 cost, compared to 10-60 seconds at ~$0.02 for AI discoveries.
                </p>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
};
