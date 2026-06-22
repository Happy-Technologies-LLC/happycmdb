import React, { useState } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { useITSMDashboard, useExportDashboard } from '@/hooks/useDashboardData';
import { KPICard } from '@/components/dashboard/KPICard';
import { IncidentTable } from '@/components/dashboard/IncidentTable';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Eyebrow } from '@/components/ui/eyebrow';

export const ITSMDashboard: React.FC = () => {
  const [priorityFilter, setPriorityFilter] = useState<string | null>(null);
  const { incidents, changes, ciStatus, topFailing, slaCompliance, baselineCompliance } = useITSMDashboard(
    priorityFilter ? { priority: priorityFilter } : undefined
  );
  const { exportToPDF, exportToExcel } = useExportDashboard();

  const loading = incidents.loading || changes.loading || ciStatus.loading;
  const error = incidents.error || changes.error || ciStatus.error;

  if (error) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load ITSM dashboard data: {error.message}
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

  // Calculate metrics
  const openIncidents = incidents.data.filter((i: any) => i.status === 'open').length;
  const inProgressIncidents = incidents.data.filter((i: any) => i.status === 'in-progress').length;
  const p1Incidents = incidents.data.filter((i: any) => i.priority === 'P1').length;
  const totalCIs = ciStatus.data.reduce((acc: number, status: any) => acc + status.count, 0);
  const activeCIs = ciStatus.data.find((s: any) => s.status === 'active')?.count || 0;

  const changesByStatus = {
    scheduled: changes.data.filter((c: any) => c.status === 'scheduled').length,
    inProgress: changes.data.filter((c: any) => c.status === 'in-progress').length,
    rollback: changes.data.filter((c: any) => c.status === 'rollback').length,
    completed: changes.data.filter((c: any) => c.status === 'completed').length,
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Eyebrow>Dashboards · ITSM</Eyebrow>
          <h1 className="mt-3 text-[1.9rem]">ITSM Dashboard</h1>
          <p className="mt-1.5 text-ink-soft">
            Incident and change management overview
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportToPDF('itsm', {})}
          >
            <Icon name="download-simple" size={16} className="mr-2" />
            Export PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => exportToExcel('itsm', {})}
          >
            <Icon name="download-simple" size={16} className="mr-2" />
            Export Excel
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              incidents.refetch();
              changes.refetch();
              ciStatus.refetch();
            }}
          >
            <Icon name="arrows-clockwise" size={16} className="mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KPICard
          title="Open Incidents"
          value={openIncidents}
          icon="warning-circle"
          color={openIncidents > 10 ? 'red' : openIncidents > 5 ? 'yellow' : 'green'}
          description={`${p1Incidents} P1 incidents`}
        />
        <KPICard
          title="In Progress"
          value={inProgressIncidents}
          icon="clock"
          color="blue"
          description="Currently being worked on"
        />
        <KPICard
          title="Active CIs"
          value={activeCIs}
          icon="check-circle"
          color="green"
          description={`${totalCIs} total CIs`}
        />
        <KPICard
          title="Changes in Progress"
          value={changesByStatus.inProgress}
          icon="arrows-clockwise"
          color="yellow"
          description={`${changesByStatus.scheduled} scheduled`}
        />
      </div>

      {/* Open Incidents Table */}
      <IncidentTable
        incidents={(incidents.data || []).map((inc: any) => ({
          id: inc.id,
          title: inc.title,
          priority: inc.priority as 'P1' | 'P2' | 'P3' | 'P4' | 'P5',
          status: inc.status as 'open' | 'in-progress' | 'resolved' | 'closed',
          affectedCI: inc.affectedCI,
          assignedTeam: inc.assignedTeam,
          createdAt: inc.createdAt,
          age: inc.age,
        }))}
        title="Open Incidents by Priority"
        description="Real-time incident tracking"
        showFilters={true}
      />

      {/* Changes in Progress */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Changes in Progress</h3>
          <p className="text-sm text-muted-foreground mb-4">Active change requests</p>
          {/* Kanban-style view */}
          <div className="grid grid-cols-4 gap-4">
            {/* Scheduled Column */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-sm">Scheduled</h4>
                <Badge variant="secondary">{changesByStatus.scheduled}</Badge>
              </div>
              <div className="space-y-2">
                {changes.data
                  .filter((c: any) => c.status === 'scheduled')
                  .map((change: any) => (
                    <LiquidGlass variant="default" rounded="xl" key={change.id} className="cursor-pointer hover:shadow-md transition-shadow">
                      <div className="p-3">
                        <p className="text-sm font-medium truncate">{change.title}</p>
                        <div className="flex items-center gap-1 mt-2">
                          <Badge variant="outline" className="text-xs">
                            {change.type}
                          </Badge>
                          {change.riskLevel && (
                            <Badge
                              variant="outline"
                              className={
                                change.riskLevel === 'high'
                                  ? 'bg-danger-soft text-danger'
                                  : change.riskLevel === 'medium'
                                  ? 'bg-warning-soft text-warning-text'
                                  : 'bg-success-soft text-success'
                              }
                            >
                              {change.riskLevel}
                            </Badge>
                          )}
                        </div>
                        {change.scheduledDate && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {new Date(change.scheduledDate).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                    </LiquidGlass>
                  ))}
              </div>
            </div>

            {/* In Progress Column */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-sm">In Progress</h4>
                <Badge variant="secondary">{changesByStatus.inProgress}</Badge>
              </div>
              <div className="space-y-2">
                {changes.data
                  .filter((c: any) => c.status === 'in-progress')
                  .map((change: any) => (
                    <LiquidGlass variant="default" rounded="xl" key={change.id} className="cursor-pointer hover:shadow-md transition-shadow border-sky">
                      <div className="p-3">
                        <p className="text-sm font-medium truncate">{change.title}</p>
                        <div className="flex items-center gap-1 mt-2">
                          <Badge variant="outline" className="text-xs">
                            {change.type}
                          </Badge>
                          {change.riskLevel && (
                            <Badge
                              variant="outline"
                              className={
                                change.riskLevel === 'high'
                                  ? 'bg-danger-soft text-danger'
                                  : change.riskLevel === 'medium'
                                  ? 'bg-warning-soft text-warning-text'
                                  : 'bg-success-soft text-success'
                              }
                            >
                              {change.riskLevel}
                            </Badge>
                          )}
                        </div>
                        {change.assignedTo && (
                          <p className="text-xs text-muted-foreground mt-1">{change.assignedTo}</p>
                        )}
                      </div>
                    </LiquidGlass>
                  ))}
              </div>
            </div>

            {/* Rollback Column */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-sm">Rollback</h4>
                <Badge variant="destructive">{changesByStatus.rollback}</Badge>
              </div>
              <div className="space-y-2">
                {changes.data
                  .filter((c: any) => c.status === 'rollback')
                  .map((change: any) => (
                    <LiquidGlass variant="default" rounded="xl" key={change.id} className="cursor-pointer hover:shadow-md transition-shadow border-danger">
                      <div className="p-3">
                        <p className="text-sm font-medium truncate">{change.title}</p>
                        <div className="flex items-center gap-1 mt-2">
                          <Badge variant="outline" className="text-xs">
                            {change.type}
                          </Badge>
                          <Badge variant="destructive" className="text-xs">
                            Failed
                          </Badge>
                        </div>
                      </div>
                    </LiquidGlass>
                  ))}
              </div>
            </div>

            {/* Completed Column */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h4 className="font-semibold text-sm">Completed</h4>
                <Badge variant="success">
                  {changesByStatus.completed}
                </Badge>
              </div>
              <div className="space-y-2">
                {changes.data
                  .filter((c: any) => c.status === 'completed')
                  .slice(0, 5)
                  .map((change: any) => (
                    <LiquidGlass variant="default" rounded="xl" key={change.id} className="cursor-pointer hover:shadow-md transition-shadow border-success">
                      <div className="p-3">
                        <p className="text-sm font-medium truncate">{change.title}</p>
                        <div className="flex items-center gap-1 mt-2">
                          <Badge variant="outline" className="text-xs">
                            {change.type}
                          </Badge>
                          <Icon name="check-circle" size={12} className="text-success" />
                        </div>
                      </div>
                    </LiquidGlass>
                  ))}
              </div>
            </div>
          </div>
        </div>
      </LiquidGlass>

      {/* CI Status Overview */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">CI Status Overview</h3>
          <p className="text-sm text-muted-foreground mb-4">Configuration Items by status</p>
          <div className="grid grid-cols-4 gap-4">
            {ciStatus.data.map((status: any) => (
              <div key={status.status} className="text-center p-4 border border-border rounded-lg">
                <p className="text-3xl font-bold">{status.count}</p>
                <Badge variant="outline" className="mt-2 capitalize">
                  {status.status}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      </LiquidGlass>

      {/* Top Failing CIs */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Top Failing CIs</h3>
          <p className="text-sm text-muted-foreground mb-4">CIs with most incidents in last 30 days</p>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-2 text-sm font-semibold">CI Name</th>
                  <th className="text-left py-3 px-2 text-sm font-semibold">Type</th>
                  <th className="text-right py-3 px-2 text-sm font-semibold">Incident Count</th>
                  <th className="text-right py-3 px-2 text-sm font-semibold">MTTR</th>
                  <th className="text-left py-3 px-2 text-sm font-semibold">Last Failure</th>
                  <th className="text-left py-3 px-2 text-sm font-semibold">Recommendation</th>
                </tr>
              </thead>
              <tbody>
                {topFailing.data.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center py-8 text-muted-foreground">
                      No failing CIs in the last 30 days
                    </td>
                  </tr>
                ) : (
                  topFailing.data.map((ci: any) => (
                    <tr key={ci.ci_id} className="border-b border-border hover:bg-accent">
                      <td className="py-3 px-2 text-sm font-medium">{ci.name}</td>
                      <td className="py-3 px-2 text-sm">
                        <Badge variant="outline">{ci.type}</Badge>
                      </td>
                      <td className="py-3 px-2 text-sm text-right">
                        <Badge variant="destructive">{ci.incidentCount}</Badge>
                      </td>
                      <td className="py-3 px-2 text-sm text-right">{ci.mttr.toFixed(1)}h</td>
                      <td className="py-3 px-2 text-sm">
                        {new Date(ci.lastFailure).toLocaleDateString()}
                      </td>
                      <td className="py-3 px-2 text-sm text-muted-foreground">{ci.recommendation}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </LiquidGlass>

      {/* SLA Compliance */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">SLA Compliance</h3>
          <p className="text-sm text-muted-foreground mb-4">Incident resolution within SLA targets</p>
          <div className="space-y-4">
            {slaCompliance.data.map((sla: any) => (
              <div key={sla.priority}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{sla.priority}</Badge>
                    <span className="text-sm">
                      {sla.withinSLA} / {sla.total} within SLA
                    </span>
                  </div>
                  <span className="text-sm font-bold">
                    {sla.compliancePercentage.toFixed(1)}% (Target: {sla.target}%)
                  </span>
                </div>
                <Progress
                  value={sla.compliancePercentage}
                  className={`h-2 ${
                    sla.compliancePercentage >= sla.target ? '' : 'bg-danger-soft'
                  }`}
                />
              </div>
            ))}
          </div>
        </div>
      </LiquidGlass>

      {/* Baseline Compliance */}
      <LiquidGlass variant="default" rounded="xl">
        <div>
          <h3 className="text-lg font-semibold mb-1">Configuration Baseline Compliance</h3>
          <p className="text-sm text-muted-foreground mb-4">CIs with detected drift from baseline</p>
          {baselineCompliance.data.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No configuration drift detected
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-2 text-sm font-semibold">CI Name</th>
                    <th className="text-left py-3 px-2 text-sm font-semibold">Type</th>
                    <th className="text-left py-3 px-2 text-sm font-semibold">Severity</th>
                    <th className="text-left py-3 px-2 text-sm font-semibold">Drift Details</th>
                    <th className="text-left py-3 px-2 text-sm font-semibold">Status</th>
                    <th className="text-left py-3 px-2 text-sm font-semibold">Last Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {baselineCompliance.data.map((ci: any) => (
                    <tr key={ci.ci_id} className="border-b border-border hover:bg-accent">
                      <td className="py-3 px-2 text-sm font-medium">{ci.name}</td>
                      <td className="py-3 px-2 text-sm">
                        <Badge variant="outline">{ci.type}</Badge>
                      </td>
                      <td className="py-3 px-2 text-sm">
                        <Badge
                          variant="outline"
                          className={
                            ci.driftSeverity === 'high'
                              ? 'bg-danger-soft text-danger'
                              : ci.driftSeverity === 'medium'
                              ? 'bg-warning-soft text-warning-text'
                              : 'bg-sky-soft text-sky-text'
                          }
                        >
                          {ci.driftSeverity}
                        </Badge>
                      </td>
                      <td className="py-3 px-2 text-sm text-muted-foreground">{ci.driftDetails}</td>
                      <td className="py-3 px-2 text-sm">
                        <Badge variant="secondary">{ci.remediationStatus}</Badge>
                      </td>
                      <td className="py-3 px-2 text-sm">
                        {new Date(ci.lastChecked).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </LiquidGlass>
    </div>
  );
};

export default ITSMDashboard;
