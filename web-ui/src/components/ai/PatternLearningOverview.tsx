// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Card, Icon, MetricCard, SectionHeading, Stat } from '@happy-technologies/design-system';
import { useDiscoverySessions } from '@/hooks/useDiscoverySessions';
import { useAIPatterns } from '@/hooks/useAIPatterns';
import { QueryState } from '@/components/estate/SurfaceState';
import { EMPTY_VALUE, NOT_AVAILABLE, averageKnown, formatCount, isKnown } from '@/lib/dashboardValue';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { brand } from '@/lib/brandColors';
import { readFailure, useReadRefusal } from './readState';

const TOOLTIP_STYLE = {
  backgroundColor: 'var(--hh-card)',
  border: '1px solid var(--hh-border)',
  borderRadius: '8px',
};

const FLYWHEEL_STEPS: Array<{ title: string; text: string; tone: string }> = [
  {
    title: 'AI Discovery',
    text: 'AI agent discovers unknown service using tools (20s, $0.02)',
    tone: 'bg-[var(--hh-accent-bg)] text-[var(--hh-accent-text)]',
  },
  {
    title: 'Pattern Detection',
    text: 'After 3+ similar discoveries, system suggests pattern',
    tone: 'bg-[var(--hh-soft-bg)] text-[var(--hh-text-primary)]',
  },
  {
    title: 'Compilation & Validation',
    text: 'Pattern compiled to TypeScript, validated for security and performance',
    tone: 'bg-[var(--hh-success-bg)] text-[var(--hh-success-text)]',
  },
  {
    title: 'Activation',
    text: 'Pattern activated after approval (manual or automatic)',
    tone: 'bg-[var(--hh-warning-bg)] text-[var(--hh-warning-text)]',
  },
  {
    title: 'Fast Matching',
    text: 'Future discoveries use pattern (<1s, $0.00) - 97% faster, 99.7% cheaper',
    tone: 'bg-[var(--hh-warning-bg)] text-[var(--hh-warning-text)]',
  },
];

export const PatternLearningOverview: React.FC = () => {
  const { learningStats, costAnalytics, loading } = useDiscoverySessions();
  const { patterns, loading: patternsLoading, error, loadPatterns } = useAIPatterns();
  const refusal = useReadRefusal();

  if (loading || patternsLoading) {
    return <QueryState what="pattern learning overview" loading />;
  }

  if (error || refusal !== null) {
    return (
      <QueryState
        what="pattern learning overview"
        error={readFailure(error, refusal)}
        onRetry={() => void loadPatterns()}
      />
    );
  }

  const activePatterns = patterns.filter(p => p.isActive);
  const pendingPatterns = patterns.filter(p => p.status === 'review');
  // Unknown (null) with no patterns, never 0
  const avgConfidence = averageKnown(patterns.map(p => p.confidenceScore));
  const avgSuccessRate = averageKnown(patterns.map(p => (p.usageCount > 0 ? p.successCount / p.usageCount : null)));
  const savings = costAnalytics?.savingsFromPatterns;
  const totalSessions = learningStats?.totalSessions;
  const percentSaved = savings?.percentSaved;
  const totalSaved = savings?.totalSaved;

  // Pattern status distribution
  const statusData = [
    { name: 'Active', value: patterns.filter(p => p.status === 'active').length, color: brand.success },
    { name: 'Approved', value: patterns.filter(p => p.status === 'approved').length, color: brand.sky },
    { name: 'Review', value: patterns.filter(p => p.status === 'review').length, color: brand.warning },
    { name: 'Draft', value: patterns.filter(p => p.status === 'draft').length, color: brand.inkSoft },
  ];

  // Cost trend data
  const costTrendData = costAnalytics?.costByDay?.map(day => ({
    date: new Date(`${day.date}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    cost: isKnown(day.cost) ? day.cost : null,
    sessions: day.sessions,
  })) || [];

  const unavailable = { value: EMPTY_VALUE, valueClass: 'text-[var(--hh-text-muted)]', sub: NOT_AVAILABLE };

  return (
    <div className="space-y-6">
      {/* Key Metrics */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
        <MetricCard
          layout="compact"
          label="Total Patterns"
          value={learningStats?.totalPatterns || patterns.length}
          annotation={{ text: `${activePatterns.length} active`, tone: 'neutral', icon: 'database' }}
        />

        <MetricCard
          layout="compact"
          label="Discovery Sessions"
          {...(isKnown(totalSessions) ? { value: totalSessions } : unavailable)}
          annotation={isKnown(totalSessions) ? { text: 'Learning active', tone: 'success', icon: 'trend-up' } : undefined}
        />

        <MetricCard
          layout="compact"
          label="Avg Confidence"
          {...(avgConfidence === null ? unavailable : { value: `${(avgConfidence * 100).toFixed(0)}%` })}
          annotation={
            avgConfidence === null
              ? undefined
              : { text: avgConfidence >= 0.9 ? 'Excellent' : 'Good', tone: avgConfidence >= 0.9 ? 'success' : 'neutral', icon: 'target' }
          }
        />

        <MetricCard
          layout="compact"
          label="Cost Savings"
          {...(isKnown(percentSaved)
            ? {
                value: `${percentSaved.toFixed(0)}%`,
                sub: isKnown(totalSaved) ? `$${totalSaved.toFixed(2)} saved` : NOT_AVAILABLE,
              }
            : unavailable)}
        />
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Cost Trend Chart */}
        <Card className="overflow-hidden">
          <SectionHeading level={3}>Cost Trend (Last 30 Days)</SectionHeading>
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={costTrendData}>
              <defs>
                <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={brand.sky} stopOpacity={0.3}/>
                  <stop offset="95%" stopColor={brand.sky} stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
              <XAxis dataKey="date" stroke="currentColor" opacity={0.5} fontSize={12} />
              <YAxis stroke="currentColor" opacity={0.5} fontSize={12} />
              <Tooltip contentStyle={TOOLTIP_STYLE} />
              <Area type="monotone" dataKey="cost" stroke={brand.sky} fillOpacity={1} fill="url(#costGradient)" />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        {/* Pattern Status Distribution */}
        <Card className="overflow-hidden">
          <SectionHeading level={3}>Pattern Status Distribution</SectionHeading>
          <ResponsiveContainer width="100%" height={250}>
            <PieChart>
              <Pie data={statusData} cx="50%" cy="50%" labelLine={false} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} outerRadius={80} fill={brand.sky} dataKey="value">
                {statusData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip contentStyle={TOOLTIP_STYLE} />
            </PieChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Learning Flywheel Explanation */}
      <Card className="overflow-hidden">
        <SectionHeading level={3}>
          <span className="flex items-center gap-2">
            <Icon name="lightning" size={20} />
            Learning Flywheel
          </span>
        </SectionHeading>
        <div className="space-y-4">
          {FLYWHEEL_STEPS.map((step, index) => (
            <div key={step.title} className="flex items-start gap-4">
              <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold ${step.tone}`}>
                {index + 1}
              </div>
              <div>
                <p className="font-semibold">{step.title}</p>
                <p className="text-sm text-[var(--hh-text-muted)]">{step.text}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card inset="none" className="flex items-center gap-3 p-4">
          <Icon name="check-circle" size={32} />
          <Stat size="sm" align="left" value={formatCount(learningStats?.autoApproved)} label="Auto-Approved" />
        </Card>

        <Card inset="none" className="flex items-center gap-3 p-4">
          <Icon name="clock" size={32} />
          <Stat size="sm" align="left" value={pendingPatterns.length} label="Pending Review" />
        </Card>

        <Card inset="none" className="flex items-center gap-3 p-4">
          <Icon name="lightning" size={32} />
          <Stat
            size="sm"
            align="left"
            value={avgSuccessRate === null ? EMPTY_VALUE : `${(avgSuccessRate * 100).toFixed(0)}%`}
            label="Success Rate"
          />
        </Card>

        <Card inset="none" className="flex items-center gap-3 p-4">
          <Icon name="trend-up" size={32} />
          <Stat size="sm" align="left" value={formatCount(savings?.patternHits)} label="Pattern Hits" />
        </Card>
      </div>
    </div>
  );
};
