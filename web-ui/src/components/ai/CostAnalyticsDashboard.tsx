import React, { useState, useEffect } from 'react';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@happy-technologies/design-system';
import { useDiscoverySessions } from '@/hooks/useDiscoverySessions';
import LoadingSpinner from '@/components/common/LoadingSpinner';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { brand, chartSeries } from '@/lib/brandColors';

export const CostAnalyticsDashboard: React.FC = () => {
  const { costAnalytics, loadCostAnalytics, loading } = useDiscoverySessions();
  const [dateRange, setDateRange] = useState<string>('30');

  useEffect(() => {
    const days = parseInt(dateRange);
    const dateTo = new Date().toISOString();
    const dateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    loadCostAnalytics(dateFrom, dateTo);
  }, [dateRange, loadCostAnalytics]);

  if (loading) {
    return <LoadingSpinner />;
  }

  if (!costAnalytics) {
    return (
      <div className="text-center text-muted-foreground py-8">
        No cost data available
      </div>
    );
  }

  // Prepare chart data
  const costTrendData = costAnalytics.costByDay?.map(day => ({
    date: new Date(day.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    cost: parseFloat(day.cost.toFixed(4)),
    sessions: day.sessions,
  })) || [];

  const providerData = costAnalytics.costByProvider?.map(provider => ({
    name: provider.provider,
    cost: parseFloat(provider.cost.toFixed(4)),
    sessions: provider.sessions,
  })) || [];

  const COLORS = chartSeries;

  return (
    <div className="space-y-6">
      {/* Date Range Selector */}
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold">Cost Analytics</h3>
        <Select value={dateRange} onValueChange={setDateRange}>
          <SelectTrigger className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
        <LiquidGlass size="sm" rounded="xl" hover>
          <div className="p-6">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-muted-foreground">Total Cost</p>
              <Icon name="currency-dollar" size={20} className="text-warning" />
            </div>
            <p className="text-3xl font-bold">${costAnalytics.totalCost.toFixed(2)}</p>
            <p className="text-xs text-muted-foreground mt-2">
              {costAnalytics.totalSessions} sessions
            </p>
          </div>
        </LiquidGlass>

        <LiquidGlass size="sm" rounded="xl" hover>
          <div className="p-6">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-muted-foreground">Avg Cost/Session</p>
              <Icon name="brain" size={20} className="text-navy" />
            </div>
            <p className="text-3xl font-bold">
              ${costAnalytics.avgCostPerSession.toFixed(4)}
            </p>
          </div>
        </LiquidGlass>

        <LiquidGlass size="sm" rounded="xl" hover>
          <div className="p-6">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-muted-foreground">Savings</p>
              <Icon name="trend-down" size={20} className="text-success" />
            </div>
            <p className="text-3xl font-bold text-success">
              ${costAnalytics.savingsFromPatterns?.totalSaved?.toFixed(2) || '0.00'}
            </p>
            <div className="flex items-center gap-1 mt-2 text-sm text-success">
              <Icon name="lightning" size={16} />
              <span>{costAnalytics.savingsFromPatterns?.percentSaved?.toFixed(0) || 0}% saved</span>
            </div>
          </div>
        </LiquidGlass>

        <LiquidGlass size="sm" rounded="xl" hover>
          <div className="p-6">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm text-muted-foreground">Pattern Efficiency</p>
              <Icon name="database" size={20} className="text-sky-text" />
            </div>
            <div className="space-y-1">
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">Pattern hits</span>
                <span className="font-semibold">
                  {costAnalytics.savingsFromPatterns?.patternHits || 0}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">AI discoveries</span>
                <span className="font-semibold">
                  {costAnalytics.savingsFromPatterns?.aiDiscoveries || 0}
                </span>
              </div>
            </div>
          </div>
        </LiquidGlass>
      </div>

      {/* Charts Row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Cost Trend */}
        <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
          <Card className="border-0 bg-transparent">
            <CardHeader>
              <CardTitle className="text-lg">Cost Trend</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
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
                    tickFormatter={(value) => `$${value}`}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#fff',
                      border: '1px solid ' + brand.line,
                      borderRadius: '8px'
                    }}
                    formatter={(value: any) => [`$${value.toFixed(4)}`, 'Cost']}
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

        {/* Session Volume */}
        <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
          <Card className="border-0 bg-transparent">
            <CardHeader>
              <CardTitle className="text-lg">Session Volume</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={costTrendData}>
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
                  <Bar dataKey="sessions" fill={brand.navy} radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </LiquidGlass>
      </div>

      {/* Charts Row 2 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Cost by Provider */}
        <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
          <Card className="border-0 bg-transparent">
            <CardHeader>
              <CardTitle className="text-lg">Cost by Provider</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={providerData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                    outerRadius={100}
                    fill={brand.sky}
                    dataKey="cost"
                  >
                    {providerData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: any) => `$${value.toFixed(4)}`}
                    contentStyle={{
                      backgroundColor: '#fff',
                      border: '1px solid ' + brand.line,
                      borderRadius: '8px'
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </LiquidGlass>

        {/* Provider Stats Table */}
        <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
          <Card className="border-0 bg-transparent">
            <CardHeader>
              <CardTitle className="text-lg">Provider Statistics</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {providerData.map((provider, index) => (
                  <div key={provider.name} className="flex items-center justify-between p-3 border rounded-lg">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: COLORS[index % COLORS.length] }}
                      />
                      <div>
                        <p className="font-semibold">{provider.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {provider.sessions} sessions
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-bold">${provider.cost.toFixed(4)}</p>
                      <p className="text-xs text-muted-foreground">
                        ${(provider.cost / provider.sessions).toFixed(4)}/session
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </LiquidGlass>
      </div>

      {/* Savings Breakdown */}
      {costAnalytics.savingsFromPatterns && costAnalytics.savingsFromPatterns.totalSaved > 0 && (
        <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
          <Card className="border-0 bg-transparent">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Icon name="lightning" size={20} className="text-warning" />
                Pattern Learning Impact
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                <div className="text-center">
                  <p className="text-3xl font-bold text-success">
                    ${costAnalytics.savingsFromPatterns.totalSaved.toFixed(2)}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">Total Saved</p>
                </div>
                <div className="text-center">
                  <p className="text-3xl font-bold text-sky-text">
                    {costAnalytics.savingsFromPatterns.percentSaved.toFixed(0)}%
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">Cost Reduction</p>
                </div>
                <div className="text-center">
                  <p className="text-3xl font-bold text-navy">
                    {costAnalytics.savingsFromPatterns.patternHits}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">Pattern Matches</p>
                </div>
                <div className="text-center">
                  <p className="text-3xl font-bold text-warning">
                    {costAnalytics.savingsFromPatterns.aiDiscoveries}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">AI Discoveries</p>
                </div>
              </div>

              <div className="mt-6 p-4 bg-success-soft border border-success/20 rounded-lg">
                <div className="flex items-start gap-3">
                  <Icon name="trend-down" size={20} className="text-success mt-0.5" />
                  <div>
                    <p className="font-semibold text-success">
                      Pattern Learning is Saving You Money
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      By automatically learning patterns from AI discoveries, you're reducing discovery costs
                      by {costAnalytics.savingsFromPatterns.percentSaved.toFixed(0)}%. Pattern matches complete
                      in &lt;1 second with $0 cost, compared to 10-60 seconds at ~$0.02 for AI discoveries.
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </LiquidGlass>
      )}
    </div>
  );
};
