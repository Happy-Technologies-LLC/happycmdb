import { Button } from "@/components/ui/button";
import { LiquidGlass } from "@/components/ui/liquid-glass";
import { Badge } from "@/components/ui/badge";
/**
 * Health Dashboard Component
 * Real-time system health and metrics overview
 */

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../../lib/api-client';
import { MetricsSummary, HealthStatus } from '../../types';
import { Icon } from '@happy-technologies/design-system';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

interface TimeSeriesData {
  time: string;
  cis: number;
  anomalies: number;
}

type TimeRange = '24h' | '90d' | '1y';

const TIME_RANGE_CONFIG: Record<TimeRange, { hours: number; label: string }> = {
  '24h': { hours: 24, label: '24 Hours' },
  '90d': { hours: 24 * 90, label: '90 Days' },
  '1y': { hours: 24 * 365, label: '1 Year' },
};

export const HealthDashboard: React.FC = () => {
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');

  const { data: metrics, refetch: refetchMetrics } = useQuery({
    queryKey: ['metrics-summary'],
    queryFn: () => apiClient.get<MetricsSummary>('/cmdb-health/metrics'),
    refetchInterval: 30000, // Auto-refresh every 30s
  });

  const { data: services, refetch: refetchServices } = useQuery({
    queryKey: ['service-health'],
    queryFn: () => apiClient.get<HealthStatus[]>('/cmdb-health/services'),
    refetchInterval: 10000, // Auto-refresh every 10s
  });

  const { data: timeSeries } = useQuery({
    queryKey: ['health-timeseries', timeRange],
    queryFn: () => apiClient.get<TimeSeriesData[]>(`/cmdb-health/timeseries?hours=${TIME_RANGE_CONFIG[timeRange].hours}`),
    refetchInterval: 60000, // Auto-refresh every minute
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'healthy':
        return 'text-green-500';
      case 'degraded':
        return 'text-yellow-500';
      case 'down':
        return 'text-red-500';
      default:
        return 'text-gray-500';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'healthy':
        return <Icon name="check-circle" size={20} />;
      case 'degraded':
        return <Icon name="warning-circle" size={20} />;
      case 'down':
        return <Icon name="x-circle" size={20} />;
      default:
        return <Icon name="pulse" size={20} />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold tracking-tight">System Health Dashboard</h2>
        <p className="text-muted-foreground mt-1">Real-time monitoring of CMDB health and performance</p>
      </div>

      {/* Key Metrics */}
      {metrics && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <LiquidGlass variant="primary" rounded="xl" size="md">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-muted-foreground">Total CIs</span>
              <Icon name="database" size={20} className="text-blue-500" />
            </div>
            <div className="text-3xl font-bold">{metrics.total_cis.toLocaleString()}</div>
            <div className="text-sm text-muted-foreground mt-1">
              {metrics.total_relationships.toLocaleString()} relationships
            </div>
          </LiquidGlass>

          <LiquidGlass variant="default" rounded="xl" size="md">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-muted-foreground">Active Connectors</span>
              <Icon name="pulse" size={20} className="text-green-500" />
            </div>
            <div className="text-3xl font-bold">{metrics.active_connectors}</div>
            <div className="text-sm text-green-600 mt-1">
              {metrics.connector_success_rate}% success rate
            </div>
          </LiquidGlass>

          <LiquidGlass variant="accent" rounded="xl" size="md">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-muted-foreground">Recent Anomalies</span>
              <Icon name="warning-circle" size={20} className="text-yellow-500" />
            </div>
            <div className="text-3xl font-bold">{metrics.recent_anomalies}</div>
            <div className="text-sm text-muted-foreground mt-1">Last 24 hours</div>
          </LiquidGlass>

          <LiquidGlass variant="muted" rounded="xl" size="md">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-muted-foreground">High Risk Changes</span>
              <Icon name="trend-up" size={20} className="text-red-500" />
            </div>
            <div className="text-3xl font-bold">{metrics.high_risk_changes}</div>
            <div className="text-sm text-muted-foreground mt-1">
              {metrics.drift_detected} drift detected
            </div>
          </LiquidGlass>
        </div>
      )}

      {/* Service Health Status */}
      <LiquidGlass variant="default" rounded="xl">
        <h3 className="text-lg font-semibold mb-4">Service Health</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {services?.map((service) => (
            <div
              key={service.service}
              className="flex items-center justify-between p-4 border border-border rounded-lg hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <span className={getStatusColor(service.status)}>{getStatusIcon(service.status)}</span>
                <div>
                  <div className="font-medium">{service.service}</div>
                  <div className="text-sm text-muted-foreground">
                    {service.response_time_ms ? `${service.response_time_ms}ms` : 'N/A'}
                  </div>
                </div>
              </div>
              <div className="text-sm text-muted-foreground">
                {new Date(service.last_check).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      </LiquidGlass>

      {/* Time Range Selector */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-muted-foreground">Time Range:</span>
        <div className="flex gap-2">
          {(Object.keys(TIME_RANGE_CONFIG) as TimeRange[]).map((range) => (
            <Button
              key={range}
              variant={timeRange === range ? 'default' : 'outline'}
              size="sm"
              onClick={() => setTimeRange(range)}
            >
              {TIME_RANGE_CONFIG[range].label}
            </Button>
          ))}
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* CI Growth Chart */}
        <LiquidGlass variant="default" rounded="xl">
          <h3 className="text-lg font-semibold mb-4">CI Growth ({TIME_RANGE_CONFIG[timeRange].label})</h3>
          {timeSeries && timeSeries.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={timeSeries}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="time" />
                <YAxis />
                <Tooltip />
                <Area type="monotone" dataKey="cis" stroke="#3B82F6" fill="#93C5FD" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[250px] text-muted-foreground">
              Loading chart data...
            </div>
          )}
        </LiquidGlass>

        {/* Anomaly Chart */}
        <LiquidGlass variant="default" rounded="xl">
          <h3 className="text-lg font-semibold mb-4">Anomalies Detected ({TIME_RANGE_CONFIG[timeRange].label})</h3>
          {timeSeries && timeSeries.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={timeSeries}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="time" />
                <YAxis />
                <Tooltip />
                <Bar dataKey="anomalies" fill="#F59E0B" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[250px] text-muted-foreground">
              Loading chart data...
            </div>
          )}
        </LiquidGlass>
      </div>

      {/* Last Updated */}
      <div className="text-sm text-muted-foreground text-center">
        Last updated: {metrics ? new Date(metrics.last_updated).toLocaleString() : 'Loading...'}
      </div>
    </div>
  );
};
