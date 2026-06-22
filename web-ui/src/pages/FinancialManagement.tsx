// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { LiquidGlass } from '../components/ui/liquid-glass';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { Eyebrow } from '../components/ui/eyebrow';
import { brand, chartSeries } from '../lib/brandColors';
import { useExportDashboard } from '../hooks/useDashboardData';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
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

const COLORS = chartSeries;

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

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <Eyebrow>Finance · FinOps</Eyebrow>
          <h1 className="mt-3 text-[1.9rem]">Financial Management</h1>
          <p className="mt-1.5 text-ink-soft">
            Technology Business Management (TBM) & FinOps
          </p>
        </div>

        <div className="flex gap-2">
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1m">Last Month</SelectItem>
              <SelectItem value="3m">Last 3 Months</SelectItem>
              <SelectItem value="6m">Last 6 Months</SelectItem>
              <SelectItem value="12m">Last 12 Months</SelectItem>
            </SelectContent>
          </Select>

          <Button variant="outline" onClick={handleExport}>
            <Icon name="download-simple" size={16} className="mr-2" />
            Export Report
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <LiquidGlass variant="default" rounded="xl">
          <div className="p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">Monthly IT Spend</span>
              <Icon name="currency-dollar" size={16} className="text-muted-foreground" />
            </div>
            <div className="text-3xl font-bold">{formatCurrency(totalMonthlyCost)}</div>
            <div className="flex items-center gap-1 mt-2">
              <Icon name="trend-up" size={12} className="text-danger" />
              <span className="text-xs text-danger">+18.5% vs last month</span>
            </div>
          </div>
        </LiquidGlass>

        <LiquidGlass variant="default" rounded="xl">
          <div className="p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">Budget Utilization</span>
              <Icon name="chart-bar" size={16} className="text-muted-foreground" />
            </div>
            <div className="text-3xl font-bold">{budgetUtilization.toFixed(1)}%</div>
            <div className="flex items-center gap-1 mt-2">
              <div className="w-full bg-secondary rounded-full h-2">
                <div
                  className="bg-gradient-to-r from-success via-warning to-danger h-2 rounded-full"
                  style={{ width: `${budgetUtilization}%` }}
                />
              </div>
            </div>
          </div>
        </LiquidGlass>

        <LiquidGlass variant="default" rounded="xl">
          <div className="p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">Potential Savings</span>
              <Icon name="trend-down" size={16} className="text-muted-foreground" />
            </div>
            <div className="text-3xl font-bold">{formatCurrency(totalPotentialSavings)}</div>
            <div className="flex items-center gap-1 mt-2">
              <span className="text-xs text-success">{optimizationOpportunities.length} opportunities identified</span>
            </div>
          </div>
        </LiquidGlass>

        <LiquidGlass variant="default" rounded="xl">
          <div className="p-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-muted-foreground">Cost per User</span>
              <Icon name="chart-pie" size={16} className="text-muted-foreground" />
            </div>
            <div className="text-3xl font-bold">$45.20</div>
            <div className="flex items-center gap-1 mt-2">
              <span className="text-xs text-muted-foreground">Across all services</span>
            </div>
          </div>
        </LiquidGlass>
      </div>

      {/* View Tabs */}
      <div className="flex gap-2 border-b">
        <button
          className={`px-4 py-2 font-medium transition-colors ${
            viewType === 'overview'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setViewType('overview')}
        >
          Overview
        </button>
        <button
          className={`px-4 py-2 font-medium transition-colors ${
            viewType === 'tower'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setViewType('tower')}
        >
          Cost by Tower
        </button>
        <button
          className={`px-4 py-2 font-medium transition-colors ${
            viewType === 'service'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setViewType('service')}
        >
          Service Costs
        </button>
        <button
          className={`px-4 py-2 font-medium transition-colors ${
            viewType === 'optimization'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          onClick={() => setViewType('optimization')}
        >
          Optimization
        </button>
      </div>

      {/* Content based on view type */}
      {viewType === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Monthly Trends */}
          <LiquidGlass variant="default" rounded="xl">
            <div className="p-6">
              <h3 className="text-lg font-semibold mb-4">Cost Trends</h3>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={monthlyTrends}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                  <XAxis dataKey="month" />
                  <YAxis tickFormatter={(value) => `$${(value / 1000).toFixed(0)}K`} />
                  <Tooltip formatter={(value: number) => formatCurrency(value)} />
                  <Legend />
                  <Line type="monotone" dataKey="compute" stroke={brand.navy} strokeWidth={2} name="Compute" />
                  <Line type="monotone" dataKey="applications" stroke={brand.sky} strokeWidth={2} name="Applications" />
                  <Line type="monotone" dataKey="storage" stroke={brand.success} strokeWidth={2} name="Storage" />
                  <Line type="monotone" dataKey="budget" stroke={brand.warning} strokeWidth={2} strokeDasharray="5 5" name="Budget" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </LiquidGlass>

          {/* Cost Distribution */}
          <LiquidGlass variant="default" rounded="xl">
            <div className="p-6">
              <h3 className="text-lg font-semibold mb-4">Cost Distribution by Tower</h3>
              <ResponsiveContainer width="100%" height={300}>
                <RechartsPieChart>
                  <Pie
                    data={costByTower}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, percentage }) => `${name}: ${percentage}%`}
                    outerRadius={100}
                    fill={brand.sky}
                    dataKey="value"
                  >
                    {costByTower.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number) => formatCurrency(value)} />
                </RechartsPieChart>
              </ResponsiveContainer>
            </div>
          </LiquidGlass>
        </div>
      )}

      {viewType === 'tower' && (
        <LiquidGlass variant="default" rounded="xl">
          <div className="p-6">
            <h3 className="text-lg font-semibold mb-4">TBM Resource Tower Breakdown</h3>
            <div className="space-y-4">
              {costByTower.map((tower, index) => (
                <div key={tower.name} className="flex items-center gap-4">
                  <div
                    className="w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold"
                    style={{ backgroundColor: COLORS[index % COLORS.length] }}
                  >
                    {tower.percentage.toFixed(0)}%
                  </div>
                  <div className="flex-1">
                    <div className="flex justify-between mb-1">
                      <span className="font-medium">{tower.name}</span>
                      <span className="font-semibold">{formatCurrency(tower.value)}</span>
                    </div>
                    <div className="w-full bg-secondary rounded-full h-2">
                      <div
                        className="h-2 rounded-full"
                        style={{
                          width: `${tower.percentage}%`,
                          backgroundColor: COLORS[index % COLORS.length],
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </LiquidGlass>
      )}

      {viewType === 'service' && (
        <LiquidGlass variant="default" rounded="xl">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-4 text-sm font-semibold">Business Service</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold">Monthly Cost</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold">Supporting CIs</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold">Users</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold">Cost/User</th>
                  <th className="text-left py-3 px-4 text-sm font-semibold">Trend</th>
                </tr>
              </thead>
              <tbody>
                {businessServiceCosts.map((service) => (
                  <tr key={service.service} className="border-b border-border hover:bg-accent transition-colors">
                    <td className="py-3 px-4 font-medium">{service.service}</td>
                    <td className="py-3 px-4">{formatCurrency(service.monthlyCost)}</td>
                    <td className="py-3 px-4 text-muted-foreground">{service.ciCount}</td>
                    <td className="py-3 px-4 text-muted-foreground">{formatNumber(service.userCount)}</td>
                    <td className="py-3 px-4">{formatCurrency(service.costPerUser)}</td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        {service.trend === 'up' && (
                          <>
                            <Icon name="trend-up" size={16} className="text-danger" />
                            <span className="text-xs text-danger">+{service.change}%</span>
                          </>
                        )}
                        {service.trend === 'down' && (
                          <>
                            <Icon name="trend-down" size={16} className="text-success" />
                            <span className="text-xs text-success">{service.change}%</span>
                          </>
                        )}
                        {service.trend === 'stable' && (
                          <span className="text-xs text-muted-foreground">Stable</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </LiquidGlass>
      )}

      {viewType === 'optimization' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">Cost Optimization Opportunities</h3>
            <Badge variant="outline" className="bg-success-soft text-success">
              Total Potential Savings: {formatCurrency(totalPotentialSavings)}
            </Badge>
          </div>

          {optimizationOpportunities.map((opp) => (
            <LiquidGlass key={opp.id} variant="default" rounded="xl">
              <div className="p-6">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <Icon name="warning-circle" size={20} className={opp.priority === 'high' ? 'text-danger' : 'text-warning'} />
                      <h4 className="font-semibold">{opp.type}</h4>
                      <Badge className={opp.priority === 'high' ? 'bg-danger-soft text-danger' : 'bg-warning-soft text-warning-text'}>
                        {opp.priority}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mb-3">{opp.description}</p>
                    <div className="flex items-center gap-4 text-sm">
                      <span className="text-muted-foreground">Affected CIs: {opp.affectedCIs}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold text-success">{formatCurrency(opp.potentialSavings)}</div>
                    <div className="text-xs text-muted-foreground">per month</div>
                    <Button className="mt-3" size="sm">
                      Take Action
                    </Button>
                  </div>
                </div>
              </div>
            </LiquidGlass>
          ))}
        </div>
      )}
    </div>
  );
};

export default FinancialManagement;
