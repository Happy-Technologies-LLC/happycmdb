import React from 'react';
import { Badge, DataTable } from '@happy-technologies/design-system';
import { useExecutiveDashboard, useTimeRange, useExportDashboard } from '@/hooks/useDashboardData';
import { KPICard } from '@/components/dashboard/KPICard';
import { CostTrendChart } from '@/components/dashboard/CostTrendChart';
import { CostBreakdownChart } from '@/components/dashboard/CostBreakdownChart';
import { RiskMatrix } from '@/components/dashboard/RiskMatrix';
import { QueryState } from '@/components/estate/SurfaceState';
import { brand } from '@/lib/brandColors';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { UnavailableNotice } from '@/components/dashboard/UnavailableNotice';
import { DashboardHeader, DashboardSection, type RangeOption } from './dashboardChrome';
import type { ExecutiveSummaryData } from '@/services/dashboard.service';
import type { TimeRange } from '@/hooks/useDashboardData';
import {
  EMPTY_VALUE, averageKnown, formatCount, formatCurrency, formatPercent, isKnown,
} from '@/lib/dashboardValue';

const RANGES: readonly RangeOption[] = [
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '1y', label: 'Last year' },
];

export const ExecutiveDashboard: React.FC = () => {
  const { timeRange, updateTimeRange } = useTimeRange('1y'); // Default to 1 year for executives
  const { data, loading, error, refetch } = useExecutiveDashboard(timeRange);
  const { exportToPDF, exportToExcel } = useExportDashboard();

  if (error || loading || !data) {
    return (
      <div className="p-6">
        <QueryState what="executive dashboard" loading={!error} error={error} onRetry={() => refetch()} />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <DashboardHeader
        eyebrow="Dashboards · Executive"
        title="Executive Dashboard"
        lede="Strategic overview of IT investment and business value"
        range={timeRange.start}
        ranges={RANGES}
        onRangeChange={updateTimeRange}
        onExportPdf={() => exportToPDF('executive', { timeRange })}
        onExportExcel={() => exportToExcel('executive', { timeRange })}
        onRefresh={() => refetch()}
      />
      <ExecutiveContent data={data} timeRange={timeRange} />
    </div>
  );
};

const ExecutiveContent: React.FC<{ data: ExecutiveSummaryData; timeRange: TimeRange }> = ({ data, timeRange }) => {
  // Safe defaults for potentially empty API responses
  const serviceHealthByTier = data.serviceHealthByTier || [];
  const riskMatrixServices = data.riskMatrix?.services || [];
  const valueScorecard = data.valueScorecard || [];
  const costByCapability = data.costByCapability || [];
  const costTrends = data.costTrends || [];
  const topCostDrivers = data.topCostDrivers || [];

  // Mean of the known tier scores; null (not 0) when no tier has a health score.
  const overallHealthScore = averageKnown(serviceHealthByTier.map((tier: any) => tier.averageHealthScore));
  const averageRoi = averageKnown(valueScorecard.map((s: any) => s.roi));

  // Calculate total risk exposure (services in critical+high risk)
  const highRiskServices = riskMatrixServices.filter(
    (s: any) => s.criticality === 'critical' && s.riskLevel === 'high'
  ).length;

  return (
    <div className="space-y-6">
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
          value={formatPercent(overallHealthScore, 0)}
          icon="pulse"
          color={overallHealthScore === null ? 'blue' : overallHealthScore >= 80 ? 'green' : overallHealthScore >= 60 ? 'yellow' : 'red'}
          trend={(data.serviceHealthByTier[0]?.trend ?? undefined) as "down" | "stable" | "up" | undefined}
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
          value={formatPercent(averageRoi)}
          icon="trend-up"
          color={isKnown(averageRoi) ? 'green' : 'blue'}
          description="Return on IT investment"
        />
      </div>

      {/* Cost Breakdown and Trends */}
      <div className="grid gap-4 md:grid-cols-2">
        <CostBreakdownChart
          data={costByCapability.filter((cap: any) => isKnown(cap.totalCost)).map((cap: any) => ({
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
        {costTrends.length > 0 ? (
          <CostTrendChart
            data={costTrends}
            title="Cost Trends"
            description="Monthly IT spend over time"
            showBudget={true}
          />
        ) : (
          <UnavailableNotice label="Cost trends" />
        )}
      </div>

      {/* Service Health by Tier */}
      <DashboardSection title="Service Health Scores by Tier" description="Average health across service tiers">
        {serviceHealthByTier.some((tier: any) => isKnown(tier.averageHealthScore)) ? (
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
        ) : (
          <UnavailableNotice label="Service health scores" />
        )}
      </DashboardSection>

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
      <DashboardSection title="Top 5 Cost Drivers" description="Services with highest monthly cost">
        {topCostDrivers.length === 0 ? (
          <UnavailableNotice label="Top cost drivers" />
        ) : (
          <>
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
                    {service.trend && isKnown(service.changePercent) ? (
                      <Badge variant={service.trend === 'up' ? 'danger' : 'default'}>
                        {service.trend === 'up' ? '↑' : '↓'} {formatPercent(Math.abs(service.changePercent))}
                      </Badge>
                    ) : (
                      <span className="text-sm text-muted-foreground" title="Change vs previous period not available yet">
                        {EMPTY_VALUE}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </DashboardSection>

      {/* Value Scorecard */}
      <DashboardSection title="Value Scorecard" description="Business value and ROI by service" flush>
        <DataTable
          rows={[...valueScorecard].sort((a: any, b: any) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity))}
          rowKey={(service: any) => service.serviceId}
          caption="Value scorecard by service"
          emptyLabel="Value scorecard: Not available yet"
          columns={[
            { header: 'Service', render: (service: any) => <span className="font-medium">{service.serviceName}</span> },
            { header: 'Annual Revenue', className: 'text-right', render: (service: any) => formatCurrency(service.annualRevenue) },
            { header: 'Monthly Cost', className: 'text-right', render: (service: any) => formatCurrency(service.monthlyCost) },
            {
              header: 'ROI',
              className: 'text-right',
              render: (service: any) => isKnown(service.roi) ? (
                <Badge variant={service.roi >= 100 ? 'success' : 'default'}>{formatPercent(service.roi)}</Badge>
              ) : (
                EMPTY_VALUE
              ),
            },
            { header: 'Customers', className: 'text-right', render: (service: any) => formatCount(service.customers) },
          ]}
        />
      </DashboardSection>
    </div>
  );
};

export default ExecutiveDashboard;
