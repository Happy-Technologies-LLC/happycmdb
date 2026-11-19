// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import {
  Badge,
  Button,
  CHART_COLORS,
  Card,
  DataTable,
  Icon,
  MetricCard,
  PageHeader,
  ProgressBar,
  SectionHeading,
  Select,
  Tabs,
  type Column,
} from '@happy-technologies/design-system';
import { useExportDashboard } from '../hooks/useDashboardData';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart as RechartsPieChart,
  Pie,
  Cell,
  Treemap,
} from 'recharts';

// Mock data
const monthlyTrends = [
  { month: 'Jan', compute: 45000, storage: 12000, network: 8000, data: 5000, security: 7000, applications: 15000, budget: 100000 },
  { month: 'Feb', compute: 48000, storage: 13000, network: 8500, data: 5200, security: 7200, applications: 16000, budget: 100000 },
  { month: 'Mar', compute: 52000, storage: 14000, network: 9000, data: 5500, security: 7500, applications: 17000, budget: 100000 },
  { month: 'Apr', compute: 55000, storage: 15000, network: 9500, data: 6000, security: 8000, applications: 18000, budget: 100000 },
  { month: 'May', compute: 58000, storage: 16000, network: 10000, data: 6500, security: 8500, applications: 19000, budget: 100000 },
  { month: 'Jun', compute: 62000, storage: 17000, network: 10500, data: 7000, security: 9000, applications: 20000, budget: 100000 },
];

const costByTower = [
  { name: 'Compute', value: 62000, percentage: 49.6 },
  { name: 'Applications', value: 20000, percentage: 16.0 },
  { name: 'Storage', value: 17000, percentage: 13.6 },
  { name: 'Network', value: 10500, percentage: 8.4 },
  { name: 'Security', value: 9000, percentage: 7.2 },
  { name: 'Data', value: 7000, percentage: 5.6 },
];

const businessServiceCosts = [
  { service: 'Customer Portal', monthlyCost: 125000, ciCount: 45, userCount: 50000, costPerUser: 2.50, trend: 'up', change: 8 },
  { service: 'Internal ERP', monthlyCost: 85000, ciCount: 32, userCount: 1500, costPerUser: 56.67, trend: 'down', change: -3 },
  { service: 'Employee Self-Service', monthlyCost: 42000, ciCount: 18, userCount: 800, costPerUser: 52.50, trend: 'stable', change: 0 },
  { service: 'Analytics Platform', monthlyCost: 68000, ciCount: 28, userCount: 250, costPerUser: 272.00, trend: 'up', change: 12 },
];

const optimizationOpportunities = [
  {
    id: '1',
    type: 'Rightsizing',
    description: 'Oversized compute instances in development',
    potentialSavings: 8500,
    priority: 'high',
    affectedCIs: 12,
  },
  {
    id: '2',
    type: 'Unused Resources',
    description: 'Idle storage volumes for 30+ days',
    potentialSavings: 3200,
    priority: 'medium',
    affectedCIs: 8,
  },
  {
    id: '3',
    type: 'Reserved Capacity',
    description: 'Convert on-demand to reserved instances',
    potentialSavings: 12000,
    priority: 'high',
    affectedCIs: 24,
  },
  {
    id: '4',
    type: 'License Optimization',
    description: 'Underutilized software licenses',
    potentialSavings: 5400,
    priority: 'medium',
    affectedCIs: 6,
  },
];

const COLORS = CHART_COLORS;

const TIME_RANGES = [
  { value: '1m', label: 'Last Month' },
  { value: '3m', label: 'Last 3 Months' },
  { value: '6m', label: 'Last 6 Months' },
  { value: '12m', label: 'Last 12 Months' },
];

type ViewType = 'overview' | 'tower' | 'service' | 'optimization';

const VIEWS: Array<{ value: ViewType; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'tower', label: 'Cost by Tower' },
  { value: 'service', label: 'Service Costs' },
  { value: 'optimization', label: 'Optimization' },
];

export const FinancialManagement: React.FC = () => {
  const [timeRange, setTimeRange] = useState('6m');
  const [viewType, setViewType] = useState<'overview' | 'tower' | 'service' | 'optimization'>('overview');
  const { exportData } = useExportDashboard();

  const totalMonthlyCost = costByTower.reduce((sum, item) => sum + item.value, 0);
  const budgetUtilization = (totalMonthlyCost / 100000) * 100;
  const totalPotentialSavings = optimizationOpportunities.reduce((sum, opp) => sum + opp.potentialSavings, 0);

  const handleExport = () => {
    exportData('financial-management', {
      timeRange,
      summary: { totalMonthlyCost, budgetUtilization, totalPotentialSavings },
      monthlyTrends,
      costByTower,
      businessServiceCosts,
      optimizationOpportunities,
    });
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

  const formatNumber = (num: number) => {
    return new Intl.NumberFormat('en-US').format(num);
  };

  const serviceColumns: Array<Column<(typeof businessServiceCosts)[number]>> = [
    { header: 'Business Service', render: (service) => <span className="font-medium">{service.service}</span> },
    { header: 'Monthly Cost', render: (service) => formatCurrency(service.monthlyCost) },
    { header: 'Supporting CIs', render: (service) => <span className="text-[var(--hh-text-muted)]">{service.ciCount}</span> },
    { header: 'Users', render: (service) => <span className="text-[var(--hh-text-muted)]">{formatNumber(service.userCount)}</span> },
    { header: 'Cost/User', render: (service) => formatCurrency(service.costPerUser) },
    {
      header: 'Trend',
      render: (service) => (
        <div className="flex items-center gap-2">
          {service.trend === 'up' && (
            <>
              <Icon name="trend-up" size={16} className="text-[var(--hh-error-text)]" />
              <span className="text-xs text-[var(--hh-error-text)]">+{service.change}%</span>
            </>
          )}
          {service.trend === 'down' && (
            <>
              <Icon name="trend-down" size={16} className="text-[var(--hh-success-text)]" />
              <span className="text-xs text-[var(--hh-success-text)]">{service.change}%</span>
            </>
          )}
          {service.trend === 'stable' && <span className="text-xs text-[var(--hh-text-muted)]">Stable</span>}
        </div>
      ),
    },
  ];

  return (
    <div className="container mx-auto p-6 space-y-6">
      <PageHeader
        eyebrow="Finance · FinOps"
        title="Financial Management"
        lede="Technology Business Management (TBM) & FinOps"
        actions={
          <>
            <Select
              aria-label="Time range"
              containerClassName="w-[180px]"
              value={timeRange}
              onChange={setTimeRange}
              options={TIME_RANGES}
            />
            <Button variant="outline" icon="download-simple" onClick={handleExport}>
              Export Report
            </Button>
          </>
        }
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <MetricCard
          icon="currency-dollar"
          label="Monthly IT Spend"
          value={formatCurrency(totalMonthlyCost)}
          annotation={{ text: '+18.5% vs last month', tone: 'danger', icon: 'trend-up' }}
        />
        <MetricCard
          icon="chart-bar"
          label="Budget Utilization"
          value={`${budgetUtilization.toFixed(1)}%`}
          sub={
            <ProgressBar
              aria-label="Budget utilization"
              value={budgetUtilization}
              tone={budgetUtilization > 100 ? 'danger' : budgetUtilization > 80 ? 'warning' : 'success'}
            />
          }
        />
        <MetricCard
          icon="trend-down"
          label="Potential Savings"
          value={formatCurrency(totalPotentialSavings)}
          annotation={{ text: `${optimizationOpportunities.length} opportunities identified`, tone: 'success' }}
        />
        <MetricCard icon="chart-pie" label="Cost per User" value="$45.20" sub="Across all services" />
      </div>

      <Tabs aria-label="Financial view" value={viewType} onChange={setViewType} options={VIEWS} />

      {/* Content based on view type */}
      {viewType === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Monthly Trends */}
          <Card>
            <SectionHeading level={3}>Cost Trends</SectionHeading>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={monthlyTrends}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="month" />
                <YAxis tickFormatter={(value) => `$${(value / 1000).toFixed(0)}K`} />
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
                <Legend />
                <Line type="monotone" dataKey="compute" stroke={COLORS[1]} strokeWidth={2} name="Compute" />
                <Line type="monotone" dataKey="applications" stroke={COLORS[0]} strokeWidth={2} name="Applications" />
                <Line type="monotone" dataKey="storage" stroke={COLORS[5]} strokeWidth={2} name="Storage" />
                <Line type="monotone" dataKey="budget" stroke={COLORS[4]} strokeWidth={2} strokeDasharray="5 5" name="Budget" />
              </LineChart>
            </ResponsiveContainer>
          </Card>

          {/* Cost Distribution */}
          <Card>
            <SectionHeading level={3}>Cost Distribution by Tower</SectionHeading>
            <ResponsiveContainer width="100%" height={300}>
              <RechartsPieChart>
                <Pie
                  data={costByTower}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percentage }) => `${name}: ${percentage}%`}
                  outerRadius={100}
                  fill={COLORS[0]}
                  dataKey="value"
                >
                  {costByTower.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
              </RechartsPieChart>
            </ResponsiveContainer>
          </Card>
        </div>
      )}

      {viewType === 'tower' && (
        <Card>
          <SectionHeading level={3}>TBM Resource Tower Breakdown</SectionHeading>
          <div className="space-y-4">
            {costByTower.map((tower, index) => (
              <div key={tower.name} className="flex items-center gap-4">
                <div
                  className="w-12 h-12 rounded-lg flex items-center justify-center font-bold text-[var(--hh-bg-page)]"
                  style={{ backgroundColor: COLORS[index % COLORS.length] }}
                >
                  {tower.percentage.toFixed(0)}%
                </div>
                <div className="flex-1">
                  <div className="flex justify-between mb-1">
                    <span className="font-medium">{tower.name}</span>
                    <span className="font-semibold">{formatCurrency(tower.value)}</span>
                  </div>
                  <ProgressBar aria-label={`${tower.name} share of cost`} value={tower.percentage} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {viewType === 'service' && (
        <DataTable rows={businessServiceCosts} columns={serviceColumns} rowKey={(service) => service.service} />
      )}

      {viewType === 'optimization' && (
        <div className="space-y-4">
          <SectionHeading
            level={3}
            className="mb-0"
            right={
              <Badge variant="success">Total Potential Savings: {formatCurrency(totalPotentialSavings)}</Badge>
            }
          >
            Cost Optimization Opportunities
          </SectionHeading>

          {optimizationOpportunities.map((opp) => (
            <Card key={opp.id}>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <Icon
                      name="warning-circle"
                      size={20}
                      className={opp.priority === 'high' ? 'text-[var(--hh-error-text)]' : 'text-[var(--hh-warning-text)]'}
                    />
                    <h4 className="font-semibold">{opp.type}</h4>
                    <Badge variant={opp.priority === 'high' ? 'danger' : 'warning'}>{opp.priority}</Badge>
                  </div>
                  <p className="text-sm text-[var(--hh-text-muted)] mb-3">{opp.description}</p>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="text-[var(--hh-text-muted)]">Affected CIs: {opp.affectedCIs}</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-bold text-[var(--hh-success-text)]">{formatCurrency(opp.potentialSavings)}</div>
                  <div className="text-xs text-[var(--hh-text-muted)]">per month</div>
                  <Button className="mt-3">Take Action</Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default FinancialManagement;
