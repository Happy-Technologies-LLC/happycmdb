import React from 'react';
import { Icon } from '@happy-technologies/design-system';
import { useFinOpsDashboard, useTimeRange, useExportDashboard } from '@/hooks/useDashboardData';
import { KPICard } from '@/components/dashboard/KPICard';
import { CostTrendChart } from '@/components/dashboard/CostTrendChart';
import { CostBreakdownChart } from '@/components/dashboard/CostBreakdownChart';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Eyebrow } from '@/components/ui/eyebrow';
import { brand } from '@/lib/brandColors';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';

export const FinOpsDashboard: React.FC = () => {
  const { timeRange, updateTimeRange } = useTimeRange('90d');
  const { cloudCosts, onPremVsCloud, costByTower, budgetVariance, unitEconomics, costOptimization } = useFinOpsDashboard(timeRange);
  const { exportToPDF, exportToExcel } = useExportDashboard();

  const loading = cloudCosts.loading || onPremVsCloud.loading || costByTower.loading;
  const error = cloudCosts.error || onPremVsCloud.error || costByTower.error;

  if (error) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load FinOps dashboard data: {error.message}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

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

  // Calculate totals
  const totalCloudCost = cloudCosts.data.reduce((acc: number, m: any) => acc + m.total, 0);
  const avgMonthlyCloudCost = totalCloudCost / (cloudCosts.data.length || 1);
  const lastMonthCost = cloudCosts.data[cloudCosts.data.length - 1]?.total || 0;
  const previousMonthCost = cloudCosts.data[cloudCosts.data.length - 2]?.total || lastMonthCost;
  const costTrend = lastMonthCost > previousMonthCost ? 'up' : 'down';
  const costTrendPercent = previousMonthCost > 0
    ? ((lastMonthCost - previousMonthCost) / previousMonthCost) * 100
    : 0;

  const totalPotentialSavings = costOptimization.data?.totalPotentialSavings || 0;

  const onPremVsCloudData = [
    { name: 'On-Premise', value: onPremVsCloud.data?.onPremCost || 0, color: brand.navy },
    { name: 'Cloud', value: onPremVsCloud.data?.cloudCost || 0, color: brand.sky },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Eyebrow>Dashboards · FinOps</Eyebrow>
          <h1 className="mt-3 text-[1.9rem]">FinOps Dashboard</h1>
          <p className="mt-1.5 text-ink-soft">
            Cloud cost management and optimization opportunities
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="px-4 py-2 border border-border rounded-md text-sm"
            value={timeRange.start}
            onChange={(e) => updateTimeRange(e.target.value)}
          >
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="1y">Last year</option>
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportToPDF('finops', { timeRange })}
          >
            <Icon name="download-simple" size={16} className="mr-2" />
            Export PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportToExcel('finops', { timeRange })}
          >
            <Icon name="download-simple" size={16} className="mr-2" />
            Export Excel
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              cloudCosts.refetch();
              onPremVsCloud.refetch();
              costByTower.refetch();
            }}
          >
            Refresh
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KPICard
          title="Total Cloud Spend"
          value={formatCurrency(totalCloudCost)}
          icon="cloud"
          color="blue"
          description={timeRange.label}
        />
        <KPICard
          title="Monthly Average"
          value={formatCurrency(avgMonthlyCloudCost)}
          icon="currency-dollar"
          color="purple"
          trend={costTrend}
          trendValue={Math.abs(costTrendPercent)}
          description="Cloud spend trend"
        />
        <KPICard
          title="Total IT Cost"
          value={formatCurrency(onPremVsCloud.data?.totalCost || 0)}
          icon="computer-tower"
          color="yellow"
          description="On-prem + Cloud"
        />
        <KPICard
          title="Potential Savings"
          value={formatCurrency(totalPotentialSavings)}
          icon="lightbulb"
          color="green"
          description="Optimization opportunities"
        />
      </div>

      {/* Cloud Spend Over Time */}
      <CostTrendChart
        data={cloudCosts.data}
        title="Cloud Spend by Provider"
        description="Monthly cloud costs across AWS, Azure, and GCP"
        stacked={true}
      />

      {/* On-Prem vs Cloud Comparison */}
      <div className="grid gap-4 md:grid-cols-2">
        <LiquidGlass variant="default" rounded="xl">
          <div>
          <h3 className="text-lg font-semibold mb-1">On-Premise vs Cloud</h3>
          <p className="text-sm text-muted-foreground mb-4">Total cost comparison</p>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={onPremVsCloudData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) =>
                    `${name}: ${(percent * 100).toFixed(1)}%`
                  }
                  outerRadius={100}
                  fill={brand.sky}
                  dataKey="value"
                >
                  {onPremVsCloudData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
              </PieChart>
            </ResponsiveContainer>
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between p-2 rounded-lg hover:bg-accent">
                <span className="text-sm font-medium">On-Premise</span>
                <span className="text-sm">{formatCurrency(onPremVsCloud.data?.onPremCost || 0)}</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded-lg hover:bg-accent">
                <span className="text-sm font-medium">Cloud</span>
                <span className="text-sm">{formatCurrency(onPremVsCloud.data?.cloudCost || 0)}</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded-lg hover:bg-accent border-t border-border pt-2">
                <span className="text-sm font-bold">Total</span>
                <span className="text-sm font-bold">{formatCurrency(onPremVsCloud.data?.totalCost || 0)}</span>
              </div>
            </div>
          </div>
        </LiquidGlass>

        <LiquidGlass variant="default" rounded="xl">
          <div>
          <h3 className="text-lg font-semibold mb-1">TCO Comparison</h3>
          <p className="text-sm text-muted-foreground mb-4">Total Cost of Ownership by category</p>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={onPremVsCloud.data?.tcoComparison || []}>
                <CartesianGrid strokeDasharray="3 3" stroke={brand.line} />
                <XAxis dataKey="category" angle={-45} textAnchor="end" height={80} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
                <YAxis tickFormatter={formatCurrency} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
                <Legend />
                <Bar dataKey="onPrem" fill={brand.navy} name="On-Premise" radius={[8, 8, 0, 0]} />
                <Bar dataKey="cloud" fill={brand.sky} name="Cloud" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </LiquidGlass>
      </div>

      {/* Cost Allocation by Tower */}
      <CostBreakdownChart
        data={costByTower.data.map((tower: any) => ({
          name: tower.tower,
          value: tower.cost,
          children: tower.subTowers?.map((sub: any) => ({
            name: sub.name,
            value: sub.cost,
          })) || [],
        }))}
        title="Cost Allocation by Resource Tower"
        description="Hierarchical view of infrastructure costs"
        type="treemap"
      />

      {/* Budget Variance */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Budget Variance by Capability</h3>
          <p className="text-sm text-muted-foreground mb-4">Actual spend vs. budget allocation</p>
          <ResponsiveContainer width="100%" height={400}>
            <BarChart data={budgetVariance.data} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={brand.line} />
              <XAxis type="number" tickFormatter={formatCurrency} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
              <YAxis dataKey="capability" type="category" width={150} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
              <Tooltip formatter={(value: number) => formatCurrency(value)} />
              <Legend />
              <Bar dataKey="budgetAllocated" fill={brand.success} name="Budget" radius={[0, 8, 8, 0]} />
              <Bar dataKey="actualSpend" fill={brand.sky} name="Actual" radius={[0, 8, 8, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <div className="mt-4 space-y-2">
            {budgetVariance.data.map((item: any) => (
              <div
                key={item.capability}
                className="flex items-center justify-between p-2 rounded-lg hover:bg-accent"
              >
                <span className="text-sm font-medium">{item.capability}</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm">
                    {formatCurrency(item.actualSpend)} / {formatCurrency(item.budgetAllocated)}
                  </span>
                  <Badge variant={item.variance < 0 ? 'success' : 'destructive'}>
                    {item.variance > 0 ? '+' : ''}{item.variancePercent.toFixed(1)}%
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      </LiquidGlass>

      {/* Unit Economics */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Unit Economics</h3>
          <p className="text-sm text-muted-foreground mb-4">Cost per unit metrics</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {unitEconomics.data.map((metric: any) => (
              <div key={metric.metric} className="p-4 border border-border rounded-lg">
                <p className="text-sm text-muted-foreground">{metric.metric}</p>
                <p className="text-2xl font-bold mt-1">
                  {typeof metric.value === 'number' ? formatCurrency(metric.value) : metric.value}
                </p>
                <p className="text-xs text-muted-foreground">{metric.unit}</p>
                {metric.trend && (
                  <div className="flex items-center gap-1 mt-2">
                    {metric.trend === 'up' ? (
                      <Icon name="trend-up" size={12} className="text-danger" />
                    ) : (
                      <Icon name="trend-down" size={12} className="text-success" />
                    )}
                    <span
                      className={`text-xs ${
                        metric.trend === 'up'
                          ? 'text-danger'
                          : 'text-success'
                      }`}
                    >
                      {metric.trend === 'up' ? '+' : ''}{metric.changePercent.toFixed(1)}%
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </LiquidGlass>

      {/* Cost Optimization Recommendations */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Cost Optimization Recommendations</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Potential savings: {formatCurrency(totalPotentialSavings)}
          </p>
          <div className="space-y-3">
            {costOptimization.data?.recommendations?.map((rec: any) => (
              <div
                key={rec.id}
                className="p-4 border border-border rounded-lg hover:bg-accent transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="outline" className="capitalize">
                        {rec.type}
                      </Badge>
                      <Badge
                        variant="outline"
                        className={
                          rec.priority === 'high'
                            ? 'bg-danger-soft text-danger'
                            : rec.priority === 'medium'
                            ? 'bg-warning-soft text-warning-text'
                            : 'bg-sky-soft text-sky-text'
                        }
                      >
                        {rec.priority}
                      </Badge>
                    </div>
                    <p className="text-sm font-medium mb-1">{rec.resource}</p>
                    <p className="text-sm text-muted-foreground">{rec.description}</p>
                  </div>
                  <div className="text-right ml-4">
                    <p className="text-sm text-muted-foreground">Current Cost</p>
                    <p className="text-sm font-medium">{formatCurrency(rec.currentCost)}/mo</p>
                    <p className="text-sm text-success font-bold mt-1">
                      Save {formatCurrency(rec.potentialSavings)}/mo
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </LiquidGlass>
    </div>
  );
};

export default FinOpsDashboard;
