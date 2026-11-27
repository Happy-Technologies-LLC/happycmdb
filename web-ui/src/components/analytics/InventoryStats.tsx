// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * InventoryStats Component
 * Main inventory statistics dashboard with multiple charts
 */

import React from 'react';
import { Button, Card, EmptyState, SectionHeading, Stat } from '@happy-technologies/design-system';
import { classifyError } from '@/lib/estate';
import { useAnalyticsOverview } from '../../hooks/useAnalytics';
import { MetricCard } from './MetricCard';
import { TypeDistribution } from './TypeDistribution';
import { StatusBreakdown } from './StatusBreakdown';
import { EnvironmentStats } from './EnvironmentStats';
import { formatHealthScore } from '@/lib/health-score';

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
        <EmptyState loading label="Loading inventory statistics..." className="min-h-[400px]" />
      </div>
    );
  }

  if (error) {
    const failure = classifyError(error);
    const forbidden = failure.kind === 'forbidden';
    return (
      <div className="p-6">
        <EmptyState
          tone="danger"
          icon={forbidden ? 'lock-key' : 'warning-circle'}
          title={forbidden ? 'Not permitted to view statistics' : 'Failed to load statistics'}
          description={failure.message}
          action={
            forbidden ? undefined : (
              <Button variant="secondary" onClick={() => void refetch()}>
                Try again
              </Button>
            )
          }
        />
      </div>
    );
  }

  const activeCIs = dashboardStats?.by_status.active ?? 0;

  const calculateActiveCIPercentage = () => {
    const totalCIs = dashboardStats?.total_cis ?? 0;
    if (totalCIs === 0) return 0;
    return (activeCIs / totalCIs) * 100;
  };

  // null = unavailable (no CI health state yet): the card says so instead of showing 0%, and has no trend.
  const healthScore = dashboardStats?.health_score ?? null;
  const healthText = formatHealthScore(healthScore);

  return (
    <div className="p-6">
      <div className="mb-6">
        <SectionHeading className="mb-1!">Inventory Statistics</SectionHeading>
        <p className="text-sm text-[var(--hh-text-muted)]">Overview of all Configuration Items</p>
      </div>

      {/* Summary Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
        <MetricCard
          title="Total CIs"
          value={dashboardStats?.total_cis ?? null}
          subtitle="All configuration items"
          loading={!dashboardStats}
        />
        <MetricCard
          title="Active CIs"
          value={activeCIs}
          subtitle={`${calculateActiveCIPercentage().toFixed(1)}% of total`}
          trend={{
            value: calculateActiveCIPercentage(),
            direction: 'up',
            isPositive: true,
          }}
          loading={!dashboardStats}
        />
        <MetricCard
          title="Critical Relationships"
          value={dashboardStats?.critical_relationships ?? null}
          subtitle="Touching a tier 1 or tier 2 CI"
          loading={!dashboardStats}
        />
        <MetricCard
          title="Health Score"
          value={healthText ?? '–'}
          subtitle={healthText === null ? 'Not available yet' : 'Overall system health'}
          trend={
            healthScore === null
              ? undefined
              : { value: healthScore, direction: healthScore >= 80 ? 'up' : 'down' }
          }
          loading={!dashboardStats}
        />
        <MetricCard
          title="Recent Discoveries"
          value={dashboardStats?.recent_discoveries?.length ?? null}
          subtitle="Recently discovered CIs"
          loading={!dashboardStats}
        />
      </div>

      {discoveryStats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 mb-6">
          <MetricCard
            title="Discovered CIs"
            value={discoveryStats.summary.total_cis}
            subtitle="Within the selected period"
          />
          <MetricCard
            title="Discovered CI Types"
            value={discoveryStats.summary.unique_types}
            subtitle="Unique configuration item types"
          />
          <MetricCard
            title="Discovery Providers"
            value={discoveryStats.by_provider.length}
            subtitle="Providers reporting discoveries"
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
        <Card as="section" className="mb-4">
          <SectionHeading>Quick Stats</SectionHeading>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
            <Stat value={ciCountsByType.length} label="CI Types" />
            {ciCountsByStatus && <Stat value={ciCountsByStatus.length} label="Status Types" />}
            {dashboardStats && dashboardStats.total_cis > 0 && (
              <Stat
                value={(dashboardStats.critical_relationships / dashboardStats.total_cis).toFixed(1)}
                label="Critical Relationships per CI"
              />
            )}
          </div>
        </Card>
      )}
    </div>
  );
};
