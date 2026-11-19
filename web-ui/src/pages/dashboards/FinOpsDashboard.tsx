import React, { useId } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  NativeSelect,
  PageHeader,
  SectionHeading,
} from '@happy-technologies/design-system';
import { useFinOpsDashboard, useTimeRange, useExportDashboard } from '@/hooks/useDashboardData';
import { KPICard } from '@/components/dashboard/KPICard';
import { CostTrendChart } from '@/components/dashboard/CostTrendChart';
import { CostBreakdownChart } from '@/components/dashboard/CostBreakdownChart';
import { QueryState } from '@/components/estate/SurfaceState';
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

/** A titled dashboard section: a labelled region with a heading and a one-line description. */
const Section: React.FC<{ title: string; description: React.ReactNode; children: React.ReactNode }> = ({
  title,
  description,
  children,
}) => {
  const headingId = useId();
  return (
    <Card as="section" aria-labelledby={headingId}>
      <SectionHeading id={headingId} className="mb-1">
        {title}
      </SectionHeading>
      <p className="mb-4 text-sm text-[var(--hh-text-muted)]">{description}</p>
      {children}
    </Card>
  );
};

export const FinOpsDashboard: React.FC = () => {
  const { timeRange, updateTimeRange } = useTimeRange('90d');
  const { unavailable, cloudCosts, onPremVsCloud, costByTower, budgetVariance, unitEconomics, costOptimization } = useFinOpsDashboard(timeRange);
  const { exportToPDF, exportToExcel } = useExportDashboard();

  const loading = cloudCosts.loading || onPremVsCloud.loading || costByTower.loading;
  const error = cloudCosts.error || onPremVsCloud.error || costByTower.error;

  const refresh = () => {
    cloudCosts.refetch();
    onPremVsCloud.refetch();
    costByTower.refetch();
  };

  const header = (
    <PageHeader
      eyebrow="Dashboards · FinOps"
      title="FinOps Dashboard"
      lede="Cloud cost management and optimization opportunities"
      actions={
        <>
          <NativeSelect
            size="sm"
            aria-label="Time range"
            value={timeRange.start}
            onChange={(e) => updateTimeRange(e.target.value)}
          >
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="1y">Last year</option>
          </NativeSelect>
          <Button
            variant="secondary"
            icon="download-simple"
            onClick={() => exportToPDF('finops', { timeRange })}
          >
            Export PDF
          </Button>
          <Button
            variant="secondary"
            icon="download-simple"
            onClick={() => exportToExcel('finops', { timeRange })}
          >
            Export Excel
          </Button>
          <Button variant="secondary" onClick={refresh}>
            Refresh
          </Button>
        </>
      }
    />
  );

  if (error) {
    return (
      <div className="space-y-6 p-6">
        {header}
        <QueryState what="FinOps dashboard" error={error} onRetry={refresh} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6">
        <QueryState what="FinOps dashboard" loading />
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

  // A payload with no rows, no figures and nothing reported unavailable: the server answered, with nothing.
  const answeredWithNothing =
    unavailable.length === 0 &&
    cloudCosts.data.length === 0 &&
    costByTower.data.length === 0 &&
    budgetVariance.data.length === 0 &&
    unitEconomics.data.length === 0 &&
    recommendations.length === 0 &&
    tcoComparison.length === 0 &&
    !isKnown(onPremCost) &&
    !isKnown(cloudCost) &&
    !isKnown(onPremVsCloud.data?.totalCost) &&
    !isKnown(totalPotentialSavings);

  if (answeredWithNothing) {
    return (
      <div className="space-y-6 p-6">
        {header}
        <EmptyState
          icon="currency-dollar"
          title="No FinOps data"
          description="The server reported no cost data for the selected range."
        />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {header}

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
          color={isKnown(totalPotentialSavings) ? 'green' : 'blue'}
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
        <Section title="On-Premise vs Cloud" description="Total cost comparison">
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
            <div className="flex items-center justify-between rounded-lg p-2 hover:bg-[var(--hh-bg-elevated)]">
              <span className="text-sm font-medium">On-Premise</span>
              <span className="text-sm">{formatCurrency(onPremCost)}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg p-2 hover:bg-[var(--hh-bg-elevated)]">
              <span className="text-sm font-medium">Cloud</span>
              <span className="text-sm">{formatCurrency(cloudCost)}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg border-t border-[var(--hh-border)] p-2 pt-2 hover:bg-[var(--hh-bg-elevated)]">
              <span className="text-sm font-bold">Total</span>
              <span className="text-sm font-bold">{formatCurrency(onPremVsCloud.data?.totalCost)}</span>
            </div>
          </div>
        </Section>

        <Section title="TCO Comparison" description="Total Cost of Ownership by category">
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
        </Section>
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
      <Section
        title="Budget Variance by Capability"
        description={hasBudget ? 'Actual spend vs. budget allocation' : 'Actual spend by capability'}
      >
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
              className="flex items-center justify-between rounded-lg p-2 hover:bg-[var(--hh-bg-elevated)]"
            >
              <span className="text-sm font-medium">{item.capability}</span>
              <div className="flex items-center gap-2">
                <span className="text-sm">
                  {formatCurrency(item.actualSpend)}
                  {isKnown(item.budgetAllocated) && ` / ${formatCurrency(item.budgetAllocated)}`}
                </span>
                {isKnown(item.variance) && isKnown(item.variancePercent) && (
                  <Badge variant={item.variance < 0 ? 'success' : 'danger'}>
                    {item.variance > 0 ? '+' : ''}{item.variancePercent.toFixed(1)}%
                  </Badge>
                )}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Unit Economics */}
      <Section title="Unit Economics" description="Cost per unit metrics">
        {unitEconomics.data.length === 0 && isUnavailable(unavailable, 'unitEconomics') ? (
          <UnavailableNotice label="Unit economics" />
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {unitEconomics.data.map((metric: any) => (
              <div key={metric.metric} className="rounded-lg bg-[var(--hh-bg-elevated)] p-4">
                <p className="text-sm text-[var(--hh-text-muted)]">{metric.metric}</p>
                <p className="mt-1 text-2xl font-bold">
                  {typeof metric.value === 'number' ? formatCurrency(metric.value) : metric.value ?? EMPTY_VALUE}
                </p>
                <p className="text-xs text-[var(--hh-text-muted)]">{metric.unit}</p>
                {metric.trend && isKnown(metric.changePercent) && (
                  <Badge variant={metric.trend === 'up' ? 'danger' : 'success'} className="mt-2">
                    <Icon name={metric.trend === 'up' ? 'trend-up' : 'trend-down'} size={12} />
                    {metric.trend === 'up' ? '+' : ''}{formatDecimal(metric.changePercent)}%
                  </Badge>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Cost Optimization Recommendations */}
      <Section
        title="Cost Optimization Recommendations"
        description={`Potential savings: ${formatCurrency(totalPotentialSavings)}`}
      >
        {recommendations.length === 0 && isUnavailable(unavailable, 'costOptimization') ? (
          <UnavailableNotice label="Cost optimization recommendations" />
        ) : (
          <div className="space-y-3">
            {recommendations.map((rec: any) => (
              <div
                key={rec.id}
                className="rounded-lg bg-[var(--hh-bg-elevated)] p-4"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="mb-2 flex items-center gap-2">
                      <Badge variant="neutral" className="capitalize">
                        {rec.type}
                      </Badge>
                      <Badge
                        variant={
                          rec.priority === 'high' ? 'danger' : rec.priority === 'medium' ? 'warning' : 'info'
                        }
                      >
                        {rec.priority}
                      </Badge>
                    </div>
                    <p className="mb-1 text-sm font-medium">{rec.resource}</p>
                    <p className="text-sm text-[var(--hh-text-muted)]">{rec.description}</p>
                  </div>
                  <div className="ml-4 text-right">
                    <p className="text-sm text-[var(--hh-text-muted)]">Current Cost</p>
                    <p className="text-sm font-medium">{formatCurrency(rec.currentCost)}/mo</p>
                    <p className="mt-1 text-sm font-bold text-[var(--hh-success-text)]">
                      Save {formatCurrency(rec.potentialSavings)}/mo
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
};

export default FinOpsDashboard;
