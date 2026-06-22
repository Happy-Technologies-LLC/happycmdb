import React from 'react';
import { Icon } from '@happy-technologies/design-system';
import { useCIODashboard, useTimeRange, useExportDashboard } from '@/hooks/useDashboardData';
import { KPICard } from '@/components/dashboard/KPICard';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
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
  LineChart,
  Line,
} from 'recharts';

export const CIODashboard: React.FC = () => {
  const { timeRange, updateTimeRange } = useTimeRange('30d');
  const { data, loading, error, refetch } = useCIODashboard(timeRange);
  const { exportToPDF, exportToExcel } = useExportDashboard();

  if (error) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load CIO dashboard data: {error.message}
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
  const serviceAvailability = data.serviceAvailability || [];
  const changeSuccessRates = data.changeSuccessRates || {} as any;
  const configurationAccuracy = data.configurationAccuracy || {} as any;
  const costByCapability = data.costByCapability || [];
  const incidentResponseTimes = data.incidentResponseTimes || [];
  const capacityPlanning = data.capacityPlanning || [];

  // Calculate averages
  const avgAvailability = serviceAvailability.length > 0
    ? serviceAvailability.reduce(
        (acc: number, tier: any) => acc + tier.averageAvailability,
        0
      ) / serviceAvailability.length
    : 0;

  const changeData = [
    { name: 'Successful', value: changeSuccessRates.successful ?? 0, color: brand.success },
    { name: 'Failed', value: changeSuccessRates.failed ?? 0, color: brand.danger },
    { name: 'Rollbacks', value: changeSuccessRates.rollbacks ?? 0, color: brand.warning },
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Eyebrow>Dashboards · CIO</Eyebrow>
          <h1 className="mt-3 text-[1.9rem]">CIO Dashboard</h1>
          <p className="mt-1.5 text-ink-soft">
            IT operations, service quality, and capacity planning
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="px-4 py-2 border border-border rounded-md text-sm"
            value={timeRange.start}
            onChange={(e) => updateTimeRange(e.target.value)}
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportToPDF('cio', { timeRange })}
          >
            <Icon name="download-simple" size={16} className="mr-2" />
            Export PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportToExcel('cio', { timeRange })}
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
          title="Average Availability"
          value={`${avgAvailability.toFixed(2)}%`}
          icon="pulse"
          color={avgAvailability >= 99.9 ? 'green' : avgAvailability >= 99 ? 'yellow' : 'red'}
          description="Across all service tiers"
        />
        <KPICard
          title="Change Success Rate"
          value={`${(changeSuccessRates?.successRate ?? 0).toFixed(1)}%`}
          icon="check-circle"
          color={(changeSuccessRates?.successRate ?? 0) >= 85 ? 'green' : 'yellow'}
          description={`${changeSuccessRates?.total ?? 0} changes (${timeRange.label})`}
        />
        <KPICard
          title="Config Accuracy"
          value={`${(configurationAccuracy?.accuracyPercentage ?? 0).toFixed(1)}%`}
          icon="database"
          color={(configurationAccuracy?.accuracyPercentage ?? 0) >= 95 ? 'green' : 'yellow'}
          description={`${configurationAccuracy?.driftDetected ?? 0} CIs with drift`}
        />
        <KPICard
          title="Total IT Budget"
          value={formatCurrency(
            costByCapability.reduce((acc: number, c: any) => acc + c.budgetAllocated, 0)
          )}
          icon="currency-dollar"
          color="blue"
          description="Allocated across capabilities"
        />
      </div>

      {/* Service Availability and Change Success */}
      <div className="grid gap-4 md:grid-cols-2">
        <LiquidGlass variant="default" rounded="xl">
          <div>
          <h3 className="text-lg font-semibold mb-1">Service Availability by Tier</h3>
          <p className="text-sm text-muted-foreground mb-4">SLA compliance by service tier</p>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={serviceAvailability}>
                <CartesianGrid strokeDasharray="3 3" stroke={brand.line} />
                <XAxis dataKey="tier" tick={{ fill: brand.inkSoft, fontSize: 12 }} />
                <YAxis domain={[95, 100]} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="averageAvailability" fill={brand.sky} name="Availability %" radius={[8, 8, 0, 0]} />
                <Bar dataKey="slaTarget" fill={brand.success} name="SLA Target %" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <div className="mt-4 space-y-2">
              {serviceAvailability.map((tier: any) => (
                <div key={tier.tier} className="flex items-center justify-between p-2 rounded-lg hover:bg-accent">
                  <span className="text-sm font-medium">{tier.tier}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{tier.averageAvailability.toFixed(2)}%</span>
                    <Badge variant={tier.complianceStatus === 'compliant' ? 'success' : 'destructive'}>
                      {tier.complianceStatus === 'compliant' ? 'Within SLA' : 'Below SLA'}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </LiquidGlass>

        <LiquidGlass variant="default" rounded="xl">
          <div>
          <h3 className="text-lg font-semibold mb-1">Change Success Rates</h3>
          <p className="text-sm text-muted-foreground mb-4">Last {timeRange.label}</p>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={changeData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) =>
                    `${name}: ${(percent * 100).toFixed(0)}%`
                  }
                  outerRadius={100}
                  fill={brand.sky}
                  dataKey="value"
                >
                  {changeData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
            <div className="mt-4 grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold text-success">
                  {changeSuccessRates.successful}
                </p>
                <p className="text-xs text-muted-foreground">Successful</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-danger">
                  {changeSuccessRates.failed}
                </p>
                <p className="text-xs text-muted-foreground">Failed</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-warning">
                  {changeSuccessRates.rollbacks}
                </p>
                <p className="text-xs text-muted-foreground">Rollbacks</p>
              </div>
            </div>
          </div>
        </LiquidGlass>
      </div>

      {/* Incident Response Times */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Incident Response Times (MTTR)</h3>
          <p className="text-sm text-muted-foreground mb-4">Mean Time to Resolution by priority</p>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={incidentResponseTimes}>
              <CartesianGrid strokeDasharray="3 3" stroke={brand.line} />
              <XAxis dataKey="priority" tick={{ fill: brand.inkSoft, fontSize: 12 }} />
              <YAxis label={{ value: 'Hours', angle: -90, position: 'insideLeft' }} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="mttr" fill={brand.danger} name="Actual MTTR" radius={[8, 8, 0, 0]} />
              <Bar dataKey="target" fill={brand.success} name="Target MTTR" radius={[8, 8, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          <div className="mt-4 space-y-2">
            {incidentResponseTimes.map((priority: any) => (
              <div key={priority.priority} className="flex items-center justify-between p-2 rounded-lg hover:bg-accent">
                <span className="text-sm font-medium">{priority.priority}</span>
                <div className="flex items-center gap-4">
                  <span className="text-sm">{priority.count} incidents</span>
                  <span className="text-sm">
                    MTTR: {priority.mttr.toFixed(1)}h / Target: {priority.target.toFixed(1)}h
                  </span>
                  <Badge variant={priority.mttr <= priority.target ? 'success' : 'destructive'}>
                    {priority.mttr <= priority.target ? 'On Target' : 'Over Target'}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      </LiquidGlass>

      {/* Configuration Accuracy */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Configuration Accuracy</h3>
          <p className="text-sm text-muted-foreground mb-4">CMDB health and drift detection status</p>
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Configuration Accuracy</span>
                <span className="text-sm font-bold">
                  {(configurationAccuracy?.accuracyPercentage ?? 0).toFixed(1)}%
                </span>
              </div>
              <Progress value={configurationAccuracy?.accuracyPercentage ?? 0} className="h-3" />
            </div>
            <div className="grid grid-cols-3 gap-4 mt-4">
              <div className="text-center p-4 border border-border rounded-lg">
                <p className="text-2xl font-bold">{configurationAccuracy.totalCIs}</p>
                <p className="text-sm text-muted-foreground">Total CIs</p>
              </div>
              <div className="text-center p-4 border border-border rounded-lg">
                <p className="text-2xl font-bold text-success">
                  {configurationAccuracy.accurateCIs}
                </p>
                <p className="text-sm text-muted-foreground">Accurate CIs</p>
              </div>
              <div className="text-center p-4 border border-border rounded-lg">
                <p className="text-2xl font-bold text-warning">
                  {configurationAccuracy.driftDetected}
                </p>
                <p className="text-sm text-muted-foreground">Drift Detected</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Last audit: {new Date(configurationAccuracy.lastAuditDate).toLocaleString()}
            </p>
          </div>
        </div>
      </LiquidGlass>

      {/* Cost by Capability */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Cost by Business Capability</h3>
          <p className="text-sm text-muted-foreground mb-4">Budget allocation and variance</p>
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={costByCapability.slice(0, 10)} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke={brand.line} />
              <XAxis type="number" tickFormatter={formatCurrency} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
              <YAxis dataKey="capability" type="category" width={150} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
              <Tooltip formatter={(value: number) => formatCurrency(value)} />
              <Legend />
              <Bar dataKey="cost" fill={brand.navy} name="Actual Cost" radius={[0, 8, 8, 0]} />
              <Bar dataKey="budgetAllocated" fill={brand.success} name="Budget" radius={[0, 8, 8, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </LiquidGlass>

      {/* Capacity Planning */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Capacity Planning</h3>
          <p className="text-sm text-muted-foreground mb-4">Resource utilization trends and forecast</p>
          <ResponsiveContainer width="100%" height={350}>
            <LineChart data={capacityPlanning}>
              <CartesianGrid strokeDasharray="3 3" stroke={brand.line} />
              <XAxis dataKey="month" tick={{ fill: brand.inkSoft, fontSize: 12 }} />
              <YAxis domain={[0, 100]} label={{ value: 'Utilization %', angle: -90, position: 'insideLeft' }} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Line
                type="monotone"
                dataKey="computeUtilization"
                stroke={brand.navy}
                strokeWidth={2}
                name="Compute"
                dot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="storageUtilization"
                stroke={brand.sky}
                strokeWidth={2}
                name="Storage"
                dot={{ r: 4 }}
              />
              <Line
                type="monotone"
                dataKey="networkUtilization"
                stroke={brand.success}
                strokeWidth={2}
                name="Network"
                dot={{ r: 4 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </LiquidGlass>
    </div>
  );
};

export default CIODashboard;
