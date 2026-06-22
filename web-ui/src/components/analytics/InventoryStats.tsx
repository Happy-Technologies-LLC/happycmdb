// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * InventoryStats Component
 * Main inventory statistics dashboard with multiple charts
 */

import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Icon } from '@happy-technologies/design-system';
import { useAnalyticsOverview } from '../../hooks/useAnalytics';
import { MetricCard } from './MetricCard';
import { TypeDistribution } from './TypeDistribution';
import { StatusBreakdown } from './StatusBreakdown';
import { EnvironmentStats } from './EnvironmentStats';
import { brand } from '@/lib/brandColors';

export const InventoryStats: React.FC = () => {
  const {
    dashboardStats,
    ciCountsByType,
    ciCountsByStatus,
    discoveryStats,
    loading,
    error,
    refetch,
  } = useAnalyticsOverview();

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex justify-center items-center h-[400px]">
          <Icon name="spinner-gap" size={32} className="animate-spin text-primary mr-4" />
          <p className="text-muted-foreground">
            Loading inventory statistics...
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertDescription>
            <p className="font-semibold">Failed to load statistics</p>
            <p className="text-sm">{error.message}</p>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const calculateActiveCIPercentage = () => {
    if (!dashboardStats) return 0;
    if (dashboardStats.totalCIs === 0) return 0;
    return (dashboardStats.activeCIs / dashboardStats.totalCIs) * 100;
  };

  const calculateHealthTrend = () => {
    if (!dashboardStats) return { value: 0, direction: 'up' as const };
    const healthScore = dashboardStats.healthScore || 0;
    return {
      value: healthScore,
      direction: healthScore >= 80 ? ('up' as const) : ('down' as const),
    };
  };

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">
          Inventory Statistics
        </h1>
        <p className="text-muted-foreground">
          Overview of all Configuration Items
        </p>
      </div>

      {/* Summary Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
        <MetricCard
          title="Total CIs"
          value={dashboardStats?.totalCIs || 0}
          subtitle="All configuration items"
          color={brand.sky}
          loading={!dashboardStats}
        />
        <MetricCard
          title="Active CIs"
          value={dashboardStats?.activeCIs || 0}
          subtitle={`${calculateActiveCIPercentage().toFixed(1)}% of total`}
          color={brand.success}
          trend={{
            value: calculateActiveCIPercentage(),
            direction: 'up',
            isPositive: true,
          }}
          loading={!dashboardStats}
        />
        <MetricCard
          title="Total Relationships"
          value={dashboardStats?.totalRelationships || 0}
          subtitle="CI connections"
          color={brand.navy}
          loading={!dashboardStats}
        />
        <MetricCard
          title="Health Score"
          value={`${dashboardStats?.healthScore || 0}%`}
          subtitle="Overall system health"
          color={brand.warning}
          trend={calculateHealthTrend()}
          loading={!dashboardStats}
        />
        <MetricCard
          title="Discovery Jobs Today"
          value={dashboardStats?.discoveryJobsToday || 0}
          subtitle="Completed today"
          color={brand.coral}
          loading={!dashboardStats}
        />
      </div>

      {discoveryStats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 mb-6">
          <MetricCard
            title="Discovery Success Rate"
            value={`${(discoveryStats.successRate * 100).toFixed(1)}%`}
            subtitle={`${discoveryStats.totalJobs} total jobs`}
            color={brand.success}
            trend={{
              value: discoveryStats.successRate * 100,
              direction: discoveryStats.successRate >= 0.9 ? 'up' : 'down',
              isPositive: discoveryStats.successRate >= 0.9,
            }}
          />
        </div>
      )}

      {/* Charts Section */}
      <div>
        <TypeDistribution />
        <StatusBreakdown />
        <EnvironmentStats />
      </div>

      {/* Additional Stats */}
      {ciCountsByType && ciCountsByType.length > 0 && (
        <Card className="mb-4">
          <CardContent className="p-6">
            <h2 className="text-xl font-semibold mb-4">
              Quick Stats
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
              <div className="text-center">
                <h3 className="text-4xl text-primary font-bold">
                  {ciCountsByType.length}
                </h3>
                <p className="text-xs text-muted-foreground">
                  CI Types
                </p>
              </div>
              {ciCountsByStatus && (
                <div className="text-center">
                  <h3 className="text-4xl text-primary font-bold">
                    {ciCountsByStatus.length}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Status Types
                  </p>
                </div>
              )}
              {dashboardStats && dashboardStats.totalCIs > 0 && (
                <div className="text-center">
                  <h3 className="text-4xl text-primary font-bold">
                    {(
                      dashboardStats.totalRelationships / dashboardStats.totalCIs
                    ).toFixed(1)}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Avg Connections/CI
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
};
