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
import { UnavailableNotice } from '@/components/dashboard/UnavailableNotice';
import {
  NOT_AVAILABLE,
  EMPTY_VALUE,
  isKnown,
  isUnavailable,
  averageKnown,
  formatCurrency,
  formatPercent,
  formatCount,
} from '@/lib/dashboardValue';
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

  // Safe defaults for potentially empty API responses
  const unavailable = data.unavailable;
  const serviceAvailability = data.serviceAvailability || [];
  const changeSuccessRates = data.changeSuccessRates || {} as any;
  const configurationAccuracy = data.configurationAccuracy || {} as any;
  const costByCapability = data.costByCapability || [];
  const incidentResponseTimes = data.incidentResponseTimes || [];
  const capacityPlanning = data.capacityPlanning || [];

  // Overall figures: only from known values; null (shown as "—") when none is known
  const avgAvailability = averageKnown(serviceAvailability.map((tier: any) => tier.averageAvailability));
  const hasAvailability = serviceAvailability.some(
    (tier: any) => isKnown(tier.averageAvailability) || isKnown(tier.slaTarget)
  );
  const knownBudgets = costByCapability.map((c: any) => c.budgetAllocated).filter(isKnown);
  const totalBudget = knownBudgets.length > 0
    ? knownBudgets.reduce((acc: number, v: number) => acc + v, 0)
    : null;
  const hasCost = costByCapability.some((c: any) => isKnown(c.cost));
  const hasBudget = knownBudgets.length > 0;

  const changeEntries: Array<{ name: string; value: number | null; color: string }> = [
    { name: 'Successful', value: changeSuccessRates.successful, color: brand.success },
    { name: 'Failed', value: changeSuccessRates.failed, color: brand.danger },
    { name: 'Rollbacks', value: changeSuccessRates.rollbacks, color: brand.warning },
  ];
  const changeData = changeEntries.filter(
    (entry): entry is { name: string; value: number; color: string } => isKnown(entry.value)
  );

  const successRate = changeSuccessRates.successRate;
  const accuracy = configurationAccuracy.accuracyPercentage;

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
          value={formatPercent(avgAvailability, 2)}
          icon="pulse"
          color={
            !isKnown(avgAvailability) ? 'blue'
              : avgAvailability >= 99.9 ? 'green'
              : avgAvailability >= 99 ? 'yellow'
              : 'red'
          }
          description="Across all service tiers"
        />
        <KPICard
          title="Change Success Rate"
          value={formatPercent(successRate)}
          icon="check-circle"
          color={!isKnown(successRate) ? 'blue' : successRate >= 85 ? 'green' : 'yellow'}
          description={
            isKnown(changeSuccessRates.total)
              ? `${formatCount(changeSuccessRates.total)} changes (${timeRange.label})`
              : `Change count: ${NOT_AVAILABLE}`
          }
        />
        <KPICard
          title="Config Accuracy"
          value={formatPercent(accuracy)}
          icon="database"
          color={!isKnown(accuracy) ? 'blue' : accuracy >= 95 ? 'green' : 'yellow'}
          description={
            isKnown(configurationAccuracy.driftDetected)
              ? `${formatCount(configurationAccuracy.driftDetected)} CIs with drift`
              : `Drift: ${NOT_AVAILABLE}`
          }
        />
        <KPICard
          title="Total IT Budget"
          value={formatCurrency(totalBudget)}
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
            {hasAvailability ? (
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
            ) : (
              <UnavailableNotice label="Service availability" />
            )}
            <div className="mt-4 space-y-2">
              {serviceAvailability.map((tier: any) => (
                <div key={tier.tier} className="flex items-center justify-between p-2 rounded-lg hover:bg-accent">
                  <span className="text-sm font-medium">{tier.tier}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{formatPercent(tier.averageAvailability, 2)}</span>
                    {tier.complianceStatus == null ? (
                      <Badge variant="outline">{NOT_AVAILABLE}</Badge>
                    ) : (
                      <Badge variant={tier.complianceStatus === 'compliant' ? 'success' : 'destructive'}>
                        {tier.complianceStatus === 'compliant' ? 'Within SLA' : 'Below SLA'}
                      </Badge>
                    )}
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
            {changeData.length > 0 ? (
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
            ) : (
              <UnavailableNotice label="Change success rates" />
            )}
            <div className="mt-4 grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold text-success">
                  {formatCount(changeSuccessRates.successful)}
                </p>
                <p className="text-xs text-muted-foreground">Successful</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-danger">
                  {formatCount(changeSuccessRates.failed)}
                </p>
                <p className="text-xs text-muted-foreground">Failed</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-warning">
                  {formatCount(changeSuccessRates.rollbacks)}
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
          {incidentResponseTimes.length === 0 && isUnavailable(unavailable, 'incidentResponseTimes') ? (
            <UnavailableNotice label="Incident response times" />
          ) : (
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
          )}
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
                <span className="text-sm font-bold">{formatPercent(accuracy)}</span>
              </div>
              {isKnown(accuracy) ? (
                <Progress value={accuracy} className="h-3" />
              ) : (
                <UnavailableNotice label="Accuracy" />
              )}
            </div>
            <div className="grid grid-cols-3 gap-4 mt-4">
              <div className="text-center p-4 border border-border rounded-lg">
                <p className="text-2xl font-bold">{formatCount(configurationAccuracy.totalCIs)}</p>
                <p className="text-sm text-muted-foreground">Total CIs</p>
              </div>
              <div className="text-center p-4 border border-border rounded-lg">
                <p className="text-2xl font-bold text-success">
                  {formatCount(configurationAccuracy.accurateCIs)}
                </p>
                <p className="text-sm text-muted-foreground">Accurate CIs</p>
              </div>
              <div className="text-center p-4 border border-border rounded-lg">
                <p className="text-2xl font-bold text-warning">
                  {formatCount(configurationAccuracy.driftDetected)}
                </p>
                <p className="text-sm text-muted-foreground">Drift Detected</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Last audit:{' '}
              {configurationAccuracy.lastAuditDate
                ? new Date(configurationAccuracy.lastAuditDate).toLocaleString()
                : EMPTY_VALUE}
            </p>
          </div>
        </div>
      </LiquidGlass>

      {/* Cost by Capability */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Cost by Business Capability</h3>
          <p className="text-sm text-muted-foreground mb-4">Budget allocation and variance</p>
          {hasCost || hasBudget ? (
            <ResponsiveContainer width="100%" height={350}>
              <BarChart data={costByCapability.slice(0, 10)} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke={brand.line} />
                <XAxis type="number" tickFormatter={formatCurrency} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
                <YAxis dataKey="capability" type="category" width={150} tick={{ fill: brand.inkSoft, fontSize: 12 }} />
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
                <Legend />
                <Bar dataKey="cost" fill={brand.navy} name="Actual Cost" radius={[0, 8, 8, 0]} />
                {hasBudget && (
                  <Bar dataKey="budgetAllocated" fill={brand.success} name="Budget" radius={[0, 8, 8, 0]} />
                )}
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <UnavailableNotice label="Cost by capability" />
          )}
          {(!hasBudget || costByCapability.some((c: any) => !isKnown(c.variance))) && (
            <div className="mt-4">
              <UnavailableNotice label="Budget and variance" />
            </div>
          )}
        </div>
      </LiquidGlass>

      {/* Capacity Planning */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Capacity Planning</h3>
          <p className="text-sm text-muted-foreground mb-4">Resource utilization trends and forecast</p>
          {capacityPlanning.length === 0 && isUnavailable(unavailable, 'capacityPlanning') ? (
            <UnavailableNotice label="Capacity planning" />
          ) : (
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
          )}
        </div>
      </LiquidGlass>
    </div>
  );
};

export default CIODashboard;
