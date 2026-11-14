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
  EMPTY_VALUE,
  averageKnown,
  formatCurrency,
  formatDecimal,
  isKnown,
  isUnavailable,
} from '@/lib/dashboardValue';
import { UnavailableNotice } from '@/components/dashboard/UnavailableNotice';
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
  const { unavailable, cloudCosts, onPremVsCloud, costByTower, budgetVariance, unitEconomics, costOptimization } = useFinOpsDashboard(timeRange);
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

  // Calculate totals. A figure with no known input stays null; it is never 0.
  const cloudTotals: number[] = cloudCosts.data.map((m: any) => m.total).filter(isKnown);
  const totalCloudCost = cloudTotals.length > 0 ? cloudTotals.reduce((acc, v) => acc + v, 0) : null;
  const avgMonthlyCloudCost = averageKnown(cloudTotals);
  const lastMonthCost = cloudCosts.data[cloudCosts.data.length - 1]?.total;
  const previousMonthCost = cloudCosts.data[cloudCosts.data.length - 2]?.total;
  const costTrendPercent =
    isKnown(lastMonthCost) && isKnown(previousMonthCost) && previousMonthCost > 0
      ? ((lastMonthCost - previousMonthCost) / previousMonthCost) * 100
      : null;
  const costTrend =
    costTrendPercent === null ? undefined : costTrendPercent > 0 ? 'up' : costTrendPercent < 0 ? 'down' : 'stable';

  const totalPotentialSavings = costOptimization.data?.totalPotentialSavings;

  const onPremCost = onPremVsCloud.data?.onPremCost;
  const cloudCost = onPremVsCloud.data?.cloudCost;
  const onPremVsCloudData = [
    { name: 'On-Premise', value: isKnown(onPremCost) ? onPremCost : 0, color: brand.navy },
    { name: 'Cloud', value: isKnown(cloudCost) ? cloudCost : 0, color: brand.sky },
  ];
  const tcoComparison = onPremVsCloud.data?.tcoComparison ?? [];

  // Towers with no known cost are listed, not charted as 0.
  const knownTowers = costByTower.data.filter((tower: any) => isKnown(tower.cost));
  const unknownTowerNames = costByTower.data
    .filter((tower: any) => !isKnown(tower.cost))
    .map((tower: any) => tower.tower);

  const hasBudget = budgetVariance.data.some((item: any) => isKnown(item.budgetAllocated));
  const hasSpend = budgetVariance.data.some((item: any) => isKnown(item.actualSpend));
  const recommendations = costOptimization.data?.recommendations ?? [];

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
          trendValue={costTrendPercent === null ? undefined : Math.abs(costTrendPercent)}
          description="Cloud spend trend"
        />
        <KPICard
          title="Total IT Cost"
          value={formatCurrency(onPremVsCloud.data?.totalCost)}
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
      {cloudCosts.data.length === 0 && isUnavailable(unavailable, 'cloudCosts') ? (
        <UnavailableNotice label="Cloud spend by provider" />
      ) : (
        <CostTrendChart
          data={cloudCosts.data}
          title="Cloud Spend by Provider"
          description="Monthly cloud costs across AWS, Azure, and GCP"
          stacked={true}
        />
      )}

      {/* On-Prem vs Cloud Comparison */}
      <div className="grid gap-4 md:grid-cols-2">
        <LiquidGlass variant="default" rounded="xl">
          <div>
          <h3 className="text-lg font-semibold mb-1">On-Premise vs Cloud</h3>
          <p className="text-sm text-muted-foreground mb-4">Total cost comparison</p>
            {isKnown(onPremCost) && isKnown(cloudCost) ? (
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
            ) : (
              <UnavailableNotice label="On-premise vs cloud cost" />
            )}
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between p-2 rounded-lg hover:bg-accent">
                <span className="text-sm font-medium">On-Premise</span>
                <span className="text-sm">{formatCurrency(onPremCost)}</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded-lg hover:bg-accent">
                <span className="text-sm font-medium">Cloud</span>
                <span className="text-sm">{formatCurrency(cloudCost)}</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded-lg hover:bg-accent border-t border-border pt-2">
                <span className="text-sm font-bold">Total</span>
                <span className="text-sm font-bold">{formatCurrency(onPremVsCloud.data?.totalCost)}</span>
              </div>
            </div>
          </div>
        </LiquidGlass>

        <LiquidGlass variant="default" rounded="xl">
          <div>
          <h3 className="text-lg font-semibold mb-1">TCO Comparison</h3>
          <p className="text-sm text-muted-foreground mb-4">Total Cost of Ownership by category</p>
            {tcoComparison.length === 0 && isUnavailable(unavailable, 'onPremVsCloud.tcoComparison') ? (
              <UnavailableNotice label="TCO comparison" />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={tcoComparison}>
                  <CartesianGrid strokeDasharray="3 3" stroke={brand.line} />
                  <XAxis dataKey="category" angle={-45} textAnchor="end" height={80} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
                  <YAxis tickFormatter={formatCurrency} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
                  <Tooltip formatter={(value: number) => formatCurrency(value)} />
                  <Legend />
                  <Bar dataKey="onPrem" fill={brand.navy} name="On-Premise" radius={[8, 8, 0, 0]} />
                  <Bar dataKey="cloud" fill={brand.sky} name="Cloud" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </LiquidGlass>
      </div>

      {/* Cost Allocation by Tower */}
      {costByTower.data.length > 0 && knownTowers.length === 0 ? (
        <UnavailableNotice label="Cost allocation by resource tower" />
      ) : (
        <CostBreakdownChart
          data={knownTowers.map((tower: any) => ({
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
      )}
      {knownTowers.length > 0 && unknownTowerNames.length > 0 && (
        <UnavailableNotice label={`Cost for ${unknownTowerNames.join(', ')}`} />
      )}

      {/* Budget Variance */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Budget Variance by Capability</h3>
          <p className="text-sm text-muted-foreground mb-4">
            {hasBudget ? 'Actual spend vs. budget allocation' : 'Actual spend by capability'}
          </p>
          {!hasBudget && isUnavailable(unavailable, 'budgetVariance.budgetAllocated') && (
            <div className="mb-4">
              <UnavailableNotice label="Budget and variance" />
            </div>
          )}
          {hasBudget || hasSpend ? (
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={budgetVariance.data} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke={brand.line} />
                <XAxis type="number" tickFormatter={formatCurrency} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
                <YAxis dataKey="capability" type="category" width={150} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
                <Legend />
                {hasBudget && (
                  <Bar dataKey="budgetAllocated" fill={brand.success} name="Budget" radius={[0, 8, 8, 0]} />
                )}
                <Bar dataKey="actualSpend" fill={brand.sky} name="Actual" radius={[0, 8, 8, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <UnavailableNotice label="Actual spend by capability" />
          )}
          <div className="mt-4 space-y-2">
            {budgetVariance.data.map((item: any) => (
              <div
                key={item.capability}
                className="flex items-center justify-between p-2 rounded-lg hover:bg-accent"
              >
                <span className="text-sm font-medium">{item.capability}</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm">
                    {formatCurrency(item.actualSpend)}
                    {isKnown(item.budgetAllocated) && ` / ${formatCurrency(item.budgetAllocated)}`}
                  </span>
                  {isKnown(item.variance) && isKnown(item.variancePercent) && (
                    <Badge variant={item.variance < 0 ? 'success' : 'destructive'}>
                      {item.variance > 0 ? '+' : ''}{item.variancePercent.toFixed(1)}%
                    </Badge>
                  )}
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
          {unitEconomics.data.length === 0 && isUnavailable(unavailable, 'unitEconomics') ? (
            <UnavailableNotice label="Unit economics" />
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {unitEconomics.data.map((metric: any) => (
                <div key={metric.metric} className="p-4 border border-border rounded-lg">
                  <p className="text-sm text-muted-foreground">{metric.metric}</p>
                  <p className="text-2xl font-bold mt-1">
                    {typeof metric.value === 'number' ? formatCurrency(metric.value) : metric.value ?? EMPTY_VALUE}
                  </p>
                  <p className="text-xs text-muted-foreground">{metric.unit}</p>
                  {metric.trend && isKnown(metric.changePercent) && (
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
                        {metric.trend === 'up' ? '+' : ''}{formatDecimal(metric.changePercent)}%
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </LiquidGlass>

      {/* Cost Optimization Recommendations */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Cost Optimization Recommendations</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Potential savings: {formatCurrency(totalPotentialSavings)}
          </p>
          {recommendations.length === 0 && isUnavailable(unavailable, 'costOptimization') ? (
            <UnavailableNotice label="Cost optimization recommendations" />
          ) : (
            <div className="space-y-3">
              {recommendations.map((rec: any) => (
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
          )}
        </div>
      </LiquidGlass>
    </div>
  );
};

export default FinOpsDashboard;
