import React from 'react';
import { Icon } from '@happy-technologies/design-system';
import { useExecutiveDashboard, useTimeRange, useExportDashboard } from '@/hooks/useDashboardData';
import { KPICard } from '@/components/dashboard/KPICard';
import { CostTrendChart } from '@/components/dashboard/CostTrendChart';
import { CostBreakdownChart } from '@/components/dashboard/CostBreakdownChart';
import { RiskMatrix } from '@/components/dashboard/RiskMatrix';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Eyebrow } from '@/components/ui/eyebrow';
import { brand } from '@/lib/brandColors';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

export const ExecutiveDashboard: React.FC = () => {
  const { timeRange, updateTimeRange } = useTimeRange('1y'); // Default to 1 year for executives
  const { data, loading, error, refetch } = useExecutiveDashboard(timeRange);
  const { exportToPDF, exportToExcel } = useExportDashboard();

  if (error) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load executive dashboard data: {error.message}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="flex justify-center items-center h-screen">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  const formatCurrency = (value: number) => {
    if (value == null || isNaN(value)) return '$0';
    if (value >= 1000000) {
      return `$${(value / 1000000).toFixed(1)}M`;
    }
    if (value >= 1000) {
      return `$${(value / 1000).toFixed(0)}K`;
    }
    return `$${value.toFixed(0)}`;
  };

  // Safe defaults for potentially empty API responses
  const serviceHealthByTier = data.serviceHealthByTier || [];
  const riskMatrixServices = data.riskMatrix?.services || [];
  const valueScorecard = data.valueScorecard || [];
  const costByCapability = data.costByCapability || [];
  const costTrends = data.costTrends || [];
  const topCostDrivers = data.topCostDrivers || [];

  // Calculate overall health score
  const overallHealthScore = serviceHealthByTier.length > 0
    ? serviceHealthByTier.reduce(
        (acc: number, tier: any) => acc + tier.averageHealthScore,
        0
      ) / serviceHealthByTier.length
    : 0;

  // Calculate total risk exposure (services in critical+high risk)
  const highRiskServices = riskMatrixServices.filter(
    (s: any) => s.criticality === 'critical' && s.riskLevel === 'high'
  ).length;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Eyebrow>Dashboards · Executive</Eyebrow>
          <h1 className="mt-3 text-[1.9rem]">Executive Dashboard</h1>
          <p className="mt-1.5 text-ink-soft">
            Strategic overview of IT investment and business value
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Time Range Selector */}
          <select
            className="px-4 py-2 border border-border rounded-md text-sm"
            value={timeRange.start}
            onChange={(e) => updateTimeRange(e.target.value)}
          >
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="1y">Last year</option>
          </select>

          {/* Export Buttons */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportToPDF('executive', { timeRange })}
          >
            <Icon name="download-simple" size={16} className="mr-2" />
            Export PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportToExcel('executive', { timeRange })}
          >
            <Icon name="download-simple" size={16} className="mr-2" />
            Export Excel
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Refresh
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KPICard
          title="Total IT Spend"
          value={formatCurrency(data.totalITSpend)}
          icon="currency-dollar"
          color="blue"
          description={timeRange.label}
        />
        <KPICard
          title="Overall Health Score"
          value={`${overallHealthScore.toFixed(0)}%`}
          icon="pulse"
          color={overallHealthScore >= 80 ? 'green' : overallHealthScore >= 60 ? 'yellow' : 'red'}
          trend={data.serviceHealthByTier[0]?.trend as "down" | "stable" | "up" | undefined}
          description="Across all service tiers"
        />
        <KPICard
          title="High Risk Services"
          value={highRiskServices}
          icon="shield"
          color={highRiskServices > 0 ? 'red' : 'green'}
          description="Requiring immediate attention"
        />
        <KPICard
          title="Average ROI"
          value={`${(
            valueScorecard.length > 0
              ? valueScorecard.reduce((acc: number, s: any) => acc + (s.roi || 0), 0) /
                valueScorecard.length
              : 0
          ).toFixed(1)}%`}
          icon="trend-up"
          color="green"
          description="Return on IT investment"
        />
      </div>

      {/* Cost Breakdown and Trends */}
      <div className="grid gap-4 md:grid-cols-2">
        <CostBreakdownChart
          data={costByCapability.map((cap: any) => ({
            name: cap.capability,
            value: cap.totalCost,
            children: (cap.businessServices || []).map((bs: any) => ({
              name: bs.serviceName,
              value: bs.monthlyCost,
            })),
          }))}
          title="Total IT Spend by Business Capability"
          description="Click to drill down into services"
          type="treemap"
        />
        <CostTrendChart
          data={costTrends}
          title="Cost Trends"
          description="Monthly IT spend over time"
          showBudget={true}
        />
      </div>

      {/* Service Health by Tier */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Service Health Scores by Tier</h3>
          <p className="text-sm text-muted-foreground mb-4">Average health across service tiers</p>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={serviceHealthByTier}>
              <CartesianGrid strokeDasharray="3 3" stroke={brand.line} />
              <XAxis dataKey="tier" tick={{ fill: brand.inkSoft, fontSize: 12 }} />
              <YAxis domain={[0, 100]} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Bar
                dataKey="averageHealthScore"
                fill={brand.navy}
                name="Health Score"
                radius={[8, 8, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </LiquidGlass>

      {/* Risk Matrix */}
      <RiskMatrix
        items={riskMatrixServices.map((s: any) => ({
          id: s.id,
          name: s.name,
          criticality: s.criticality as 'low' | 'medium' | 'high' | 'critical',
          riskLevel: s.riskLevel as 'low' | 'medium' | 'high' | 'critical',
          type: s.type,
          description: s.description,
        }))}
        title="Risk Exposure Matrix"
        description="Services plotted by business criticality vs risk level"
      />

      {/* Top 5 Cost Drivers */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Top 5 Cost Drivers</h3>
          <p className="text-sm text-muted-foreground mb-4">Services with highest monthly cost</p>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={topCostDrivers.slice(0, 5)} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={brand.line} />
              <XAxis type="number" tickFormatter={formatCurrency} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
              <YAxis dataKey="serviceName" type="category" width={150} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
              <Tooltip formatter={(value: number) => formatCurrency(value)} />
              <Bar dataKey="monthlyCost" fill={brand.sky} name="Monthly Cost" radius={[0, 8, 8, 0]}>
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="mt-4 space-y-2">
            {topCostDrivers.slice(0, 5).map((service: any) => (
              <div
                key={service.serviceId}
                className="flex items-center justify-between p-2 rounded-lg hover:bg-accent"
              >
                <span className="text-sm font-medium">{service.serviceName}</span>
                <div className="flex items-center gap-2">
                  <span className="text-sm">{formatCurrency(service.monthlyCost)}/mo</span>
                  {service.trend && (
                    <Badge variant={service.trend === 'up' ? 'destructive' : 'default'}>
                      {service.trend === 'up' ? '↑' : '↓'} {Math.abs(service.changePercent)}%
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </LiquidGlass>

      {/* Value Scorecard */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Value Scorecard</h3>
          <p className="text-sm text-muted-foreground mb-4">Business value and ROI by service</p>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-2 text-sm font-semibold">Service</th>
                  <th className="text-right py-3 px-2 text-sm font-semibold">Annual Revenue</th>
                  <th className="text-right py-3 px-2 text-sm font-semibold">Monthly Cost</th>
                  <th className="text-right py-3 px-2 text-sm font-semibold">ROI</th>
                  <th className="text-right py-3 px-2 text-sm font-semibold">Customers</th>
                </tr>
              </thead>
              <tbody>
                {valueScorecard
                  .sort((a: any, b: any) => (b.roi || 0) - (a.roi || 0))
                  .map((service: any) => (
                    <tr key={service.serviceId} className="border-b border-border hover:bg-accent">
                      <td className="py-3 px-2 text-sm font-medium">{service.serviceName}</td>
                      <td className="py-3 px-2 text-sm text-right">
                        {formatCurrency(service.annualRevenue)}
                      </td>
                      <td className="py-3 px-2 text-sm text-right">
                        {formatCurrency(service.monthlyCost)}
                      </td>
                      <td className="py-3 px-2 text-sm text-right">
                        <Badge variant={service.roi >= 100 ? 'success' : 'secondary'}>
                          {service.roi.toFixed(1)}%
                        </Badge>
                      </td>
                      <td className="py-3 px-2 text-sm text-right">
                        {service.customers.toLocaleString()}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </LiquidGlass>
    </div>
  );
};

export default ExecutiveDashboard;
