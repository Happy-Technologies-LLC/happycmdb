// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Brain, TrendingUp, Database, Zap, CheckCircle, Clock, DollarSign, Target } from 'lucide-react';
import { useDiscoverySessions } from '@/hooks/useDiscoverySessions';
import { useAIPatterns } from '@/hooks/useAIPatterns';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import { LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { brand } from '@/lib/brandColors';

export const PatternLearningOverview: React.FC = () => {
  const { learningStats, costAnalytics, loading } = useDiscoverySessions();
  const { patterns } = useAIPatterns();

  if (loading) {
    return <LoadingSpinner />;
  }

  const activePatterns = patterns.filter(p => p.isActive);
  const pendingPatterns = patterns.filter(p => p.status === 'review');
  const avgConfidence = patterns.reduce((sum, p) => sum + p.confidenceScore, 0) / (patterns.length || 1);
  const avgSuccessRate = patterns.reduce((sum, p) =>
    sum + (p.usageCount > 0 ? p.successCount / p.usageCount : 0), 0
  ) / (patterns.length || 1);

  // Pattern status distribution
  const statusData = [
    { name: 'Active', value: patterns.filter(p => p.status === 'active').length, color: brand.success },
    { name: 'Approved', value: patterns.filter(p => p.status === 'approved').length, color: brand.sky },
    { name: 'Review', value: patterns.filter(p => p.status === 'review').length, color: brand.warning },
    { name: 'Draft', value: patterns.filter(p => p.status === 'draft').length, color: brand.inkSoft },
  ];

  // Cost trend data (mock - replace with real data)
  const costTrendData = costAnalytics?.costByDay?.map(day => ({
    date: new Date(day.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    cost: day.cost,
    sessions: day.sessions,
  })) || [];

  return (
    <div className="space-y-6">
      {/* Key Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
        <LiquidGlass size="sm" rounded="xl" hover>
          <div className="p-6">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-muted-foreground">Total Patterns</p>
              <Database className="h-5 w-5 text-primary" />
            </div>
            <p className="text-3xl font-bold">{learningStats?.totalPatterns || patterns.length}</p>
            <div className="flex items-center gap-2 mt-2">
              <Badge variant="secondary" className="text-xs">
                {activePatterns.length} active
              </Badge>
            </div>
          </div>
        </LiquidGlass>

        <LiquidGlass size="sm" rounded="xl" hover>
          <div className="p-6">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-muted-foreground">Discovery Sessions</p>
              <Brain className="h-5 w-5 text-navy" />
            </div>
            <p className="text-3xl font-bold">{learningStats?.totalSessions || 0}</p>
            <div className="flex items-center gap-1 mt-2 text-sm text-success">
              <TrendingUp className="h-4 w-4" />
              <span>Learning active</span>
            </div>
          </div>
        </LiquidGlass>

        <LiquidGlass size="sm" rounded="xl" hover>
          <div className="p-6">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-muted-foreground">Avg Confidence</p>
              <Target className="h-5 w-5 text-sky-text" />
            </div>
            <p className="text-3xl font-bold">{(avgConfidence * 100).toFixed(0)}%</p>
            <div className="flex items-center gap-2 mt-2">
              <Badge
                variant={avgConfidence >= 0.9 ? "default" : "secondary"}
                className="text-xs"
              >
                {avgConfidence >= 0.9 ? 'Excellent' : 'Good'}
              </Badge>
            </div>
          </div>
        </LiquidGlass>

        <LiquidGlass size="sm" rounded="xl" hover>
          <div className="p-6">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-muted-foreground">Cost Savings</p>
              <DollarSign className="h-5 w-5 text-success" />
            </div>
            <p className="text-3xl font-bold">
              {costAnalytics?.savingsFromPatterns?.percentSaved
                ? `${costAnalytics.savingsFromPatterns.percentSaved.toFixed(0)}%`
                : '0%'
              }
            </p>
            <div className="flex items-center gap-1 mt-2 text-sm text-muted-foreground">
              <span>
                ${costAnalytics?.savingsFromPatterns?.totalSaved?.toFixed(2) || '0.00'} saved
              </span>
            </div>
          </div>
        </LiquidGlass>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Cost Trend Chart */}
        <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
          <Card className="border-0 bg-transparent">
            <CardHeader>
              <CardTitle className="text-lg">Cost Trend (Last 30 Days)</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <AreaChart data={costTrendData}>
                  <defs>
                    <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={brand.sky} stopOpacity={0.3}/>
                      <stop offset="95%" stopColor={brand.sky} stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
                  <XAxis
                    dataKey="date"
                    stroke="currentColor"
                    opacity={0.5}
                    fontSize={12}
                  />
                  <YAxis
                    stroke="currentColor"
                    opacity={0.5}
                    fontSize={12}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#fff',
                      border: '1px solid ' + brand.line,
                      borderRadius: '8px'
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="cost"
                    stroke={brand.sky}
                    fillOpacity={1}
                    fill="url(#costGradient)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </LiquidGlass>

        {/* Pattern Status Distribution */}
        <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
          <Card className="border-0 bg-transparent">
            <CardHeader>
              <CardTitle className="text-lg">Pattern Status Distribution</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart>
                  <Pie
                    data={statusData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    outerRadius={80}
                    fill={brand.sky}
                    dataKey="value"
                  >
                    {statusData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </LiquidGlass>
      </div>

      {/* Learning Flywheel Explanation */}
      <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
        <Card className="border-0 bg-transparent">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Zap className="h-5 w-5 text-warning" />
              Learning Flywheel
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-sky-soft flex items-center justify-center text-sm font-bold text-sky-text">
                  1
                </div>
                <div>
                  <p className="font-semibold">AI Discovery</p>
                  <p className="text-sm text-muted-foreground">
                    AI agent discovers unknown service using tools (20s, $0.02)
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-navy/10 flex items-center justify-center text-sm font-bold text-navy">
                  2
                </div>
                <div>
                  <p className="font-semibold">Pattern Detection</p>
                  <p className="text-sm text-muted-foreground">
                    After 3+ similar discoveries, system suggests pattern
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-success-soft flex items-center justify-center text-sm font-bold text-success">
                  3
                </div>
                <div>
                  <p className="font-semibold">Compilation & Validation</p>
                  <p className="text-sm text-muted-foreground">
                    Pattern compiled to TypeScript, validated for security and performance
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-warning-soft flex items-center justify-center text-sm font-bold text-warning">
                  4
                </div>
                <div>
                  <p className="font-semibold">Activation</p>
                  <p className="text-sm text-muted-foreground">
                    Pattern activated after approval (manual or automatic)
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-warning-soft flex items-center justify-center text-sm font-bold text-warning">
                  5
                </div>
                <div>
                  <p className="font-semibold">Fast Matching</p>
                  <p className="text-sm text-muted-foreground">
                    Future discoveries use pattern (&lt;1s, $0.00) - 97% faster, 99.7% cheaper
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </LiquidGlass>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <LiquidGlass size="sm" rounded="xl">
          <div className="p-4 flex items-center gap-3">
            <CheckCircle className="h-8 w-8 text-success" />
            <div>
              <p className="text-2xl font-bold">{learningStats?.autoApproved || 0}</p>
              <p className="text-xs text-muted-foreground">Auto-Approved</p>
            </div>
          </div>
        </LiquidGlass>

        <LiquidGlass size="sm" rounded="xl">
          <div className="p-4 flex items-center gap-3">
            <Clock className="h-8 w-8 text-warning" />
            <div>
              <p className="text-2xl font-bold">{pendingPatterns.length}</p>
              <p className="text-xs text-muted-foreground">Pending Review</p>
            </div>
          </div>
        </LiquidGlass>

        <LiquidGlass size="sm" rounded="xl">
          <div className="p-4 flex items-center gap-3">
            <Zap className="h-8 w-8 text-sky-text" />
            <div>
              <p className="text-2xl font-bold">{(avgSuccessRate * 100).toFixed(0)}%</p>
              <p className="text-xs text-muted-foreground">Success Rate</p>
            </div>
          </div>
        </LiquidGlass>

        <LiquidGlass size="sm" rounded="xl">
          <div className="p-4 flex items-center gap-3">
            <TrendingUp className="h-8 w-8 text-navy" />
            <div>
              <p className="text-2xl font-bold">
                {costAnalytics?.savingsFromPatterns?.patternHits || 0}
              </p>
              <p className="text-xs text-muted-foreground">Pattern Hits</p>
            </div>
          </div>
        </LiquidGlass>
      </div>
    </div>
  );
};
