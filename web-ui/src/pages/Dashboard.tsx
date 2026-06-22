// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
} from 'recharts';
import {
  PageHeader,
  MetricCard,
  Card,
  Button,
  Icon,
  StatusBadge,
  ErrorBanner,
} from '@happy-technologies/design-system';
import { brand } from '@/lib/brandColors';
import ciService from '../services/ci.service';
import CITypeBadge from '../components/ci/CITypeBadge';
import CIStatusBadge from '../components/ci/CIStatusBadge';

const STATUS_COLORS: Record<string, string> = {
  active: brand.success,
  inactive: brand.inkSoft,
  maintenance: brand.warning,
  decommissioned: brand.danger,
};

const ENVIRONMENT_COLORS: Record<string, string> = {
  production: brand.navy,
  staging: brand.sky,
  development: brand.skyText,
  test: brand.coral,
};

/** Phosphor glyph for a CI type shown in the recent-discoveries feed. */
const typeGlyph = (type: string): string =>
  type === 'virtual-machine'
    ? 'cloud'
    : type === 'database'
      ? 'hard-drive'
      : type === 'application'
        ? 'app-window'
        : 'desktop';

export const Dashboard: React.FC = () => {
  const navigate = useNavigate();

  const {
    data: stats,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => ciService.getDashboardStats(),
    staleTime: 60000,
    refetchInterval: 300000,
  });

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (error) {
    return <ErrorBanner message={`Failed to load dashboard data. ${(error as Error).message}`} />;
  }

  if (isLoading || !stats) {
    return (
      <div className="flex justify-center py-20">
        <Icon name="spinner-gap" size={40} className="animate-spin text-[var(--hh-accent-text)]" />
      </div>
    );
  }

  const statusData = Object.entries(stats.by_status).map(([status, count]) => ({
    name: status.charAt(0).toUpperCase() + status.slice(1),
    value: count,
    color: STATUS_COLORS[status] || brand.inkSoft,
  }));

  const environmentData = Object.entries(stats.by_environment).map(([env, count]) => ({
    name: env.charAt(0).toUpperCase() + env.slice(1),
    value: count,
    color: ENVIRONMENT_COLORS[env] || brand.skyLight,
  }));

  const typeData = Object.entries(stats.by_type)
    .map(([type, count]) => ({
      name: type
        .split('-')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' '),
      count,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const healthTone: 'success' | 'amber' | 'danger' =
    stats.health_score >= 0.8 ? 'success' : stats.health_score >= 0.5 ? 'amber' : 'danger';

  return (
    <div className="mx-auto max-w-[1280px]">
      <PageHeader
        size="lg"
        eyebrow="Configuration Plane · Overview"
        title="CMDB Dashboard"
        lede={`Your service graph is healthy. ${stats.total_cis} configuration items reconciled across the estate.`}
        actions={
          <>
            <Button size="md" icon="broadcast" onClick={() => navigate('/discovery')}>
              Run discovery
            </Button>
            <Button size="md" variant="secondary" icon="database" onClick={() => navigate('/cis')}>
              Inventory
            </Button>
          </>
        }
      />

      {/* KPI row */}
      <div className="mt-7 mb-[22px] grid grid-cols-2 gap-[18px] lg:grid-cols-4">
        <button
          type="button"
          onClick={() => navigate('/cis')}
          className="hh-focus block w-full text-left transition-transform hover:-translate-y-0.5"
        >
          <MetricCard
            icon="desktop"
            tone="accent"
            value={stats.total_cis}
            label="Total configuration items"
          />
        </button>
        <button
          type="button"
          onClick={() => navigate('/cis?status=active')}
          className="hh-focus block w-full text-left transition-transform hover:-translate-y-0.5"
        >
          <MetricCard
            icon="check-circle"
            tone="success"
            value={stats.by_status.active || 0}
            label="Active CIs"
          />
        </button>
        <button
          type="button"
          onClick={() => navigate('/cmdb-health')}
          className="hh-focus block w-full text-left transition-transform hover:-translate-y-0.5"
        >
          <MetricCard
            icon="trend-up"
            tone={healthTone}
            value={`${(stats.health_score * 100).toFixed(0)}%`}
            label="Health score"
          />
        </button>
        <button
          type="button"
          onClick={() => navigate('/anomalies')}
          className="hh-focus block w-full text-left transition-transform hover:-translate-y-0.5"
        >
          <MetricCard
            icon="warning"
            tone="amber"
            value={stats.critical_relationships}
            label="Critical relationships"
          />
        </button>
      </div>

      {/* Distributions */}
      <div className="mb-[18px] grid gap-[18px] md:grid-cols-2">
        <Card className="p-6">
          <h3 className="mb-4 text-[1.15rem]">CI status distribution</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={statusData}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                outerRadius={100}
                dataKey="value"
                onClick={(d) => navigate(`/cis?status=${String(d.name).toLowerCase()}`)}
                style={{ cursor: 'pointer' }}
              >
                {statusData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <RechartsTooltip />
            </PieChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-6">
          <h3 className="mb-4 text-[1.15rem]">Environment distribution</h3>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={environmentData}
                cx="50%"
                cy="50%"
                labelLine={false}
                label={({ name, percent }) => `${name}: ${(percent * 100).toFixed(0)}%`}
                outerRadius={100}
                dataKey="value"
                onClick={(d) => navigate(`/cis?environment=${String(d.name).toLowerCase()}`)}
                style={{ cursor: 'pointer' }}
              >
                {environmentData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} />
                ))}
              </Pie>
              <RechartsTooltip />
            </PieChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Types + recent */}
      <div className="mb-[18px] grid gap-[18px] md:grid-cols-3">
        <Card className="p-6 md:col-span-2">
          <h3 className="mb-4 text-[1.15rem]">Top CI types</h3>
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={typeData}>
              <CartesianGrid strokeDasharray="3 3" stroke={brand.line} />
              <XAxis
                dataKey="name"
                angle={-45}
                textAnchor="end"
                height={100}
                tick={{ fill: brand.inkSoft, fontSize: 12 }}
              />
              <YAxis tick={{ fill: brand.inkSoft, fontSize: 12 }} />
              <RechartsTooltip />
              <Legend />
              <Bar
                dataKey="count"
                fill={brand.sky}
                name="Count"
                radius={[6, 6, 0, 0]}
                onClick={(d) => navigate(`/cis?type=${String(d.name).toLowerCase().replace(/ /g, '-')}`)}
                style={{ cursor: 'pointer' }}
              />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-6">
          <h3 className="mb-4 text-[1.15rem]">Recent discoveries</h3>
          {stats.recent_discoveries.length > 0 ? (
            <div className="max-h-[350px] space-y-2 overflow-y-auto">
              {stats.recent_discoveries.map((ci) => (
                <button
                  key={ci.id}
                  className="flex w-full items-start gap-3 rounded-md border border-transparent p-3 text-left transition-colors hover:border-[var(--hh-border)] hover:bg-[var(--hh-bg-page)]"
                  onClick={() => navigate(`/cis/${ci.id}`)}
                >
                  <span className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-sm bg-[var(--hh-accent-bg)] text-[var(--hh-accent-text)]">
                    <Icon name={typeGlyph(ci.type)} size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-display text-sm font-semibold text-[var(--hh-text-primary)]">
                      {ci.name}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <CITypeBadge type={ci.type} size="small" />
                      <CIStatusBadge status={ci.status} size="small" />
                    </div>
                    {ci.last_discovered && (
                      <p className="mt-1 text-xs text-[var(--hh-text-muted)]">
                        {formatDate(ci.last_discovered)}
                      </p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="py-8 text-center text-[var(--hh-text-muted)]">No recent discoveries</p>
          )}
        </Card>
      </div>

      {/* Status breakdown */}
      <Card className="p-6">
        <h3 className="mb-6 text-[1.15rem]">Status breakdown</h3>
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
          {Object.entries(stats.by_status).map(([status, count]) => {
            const color = STATUS_COLORS[status] || brand.inkSoft;
            return (
              <div
                key={status}
                className="rounded-lg border border-[var(--hh-border)] bg-[var(--hh-bg-page)] p-4 text-center"
              >
                <p className="font-display text-3xl font-extrabold leading-none" style={{ color }}>
                  {count}
                </p>
                <div className="mt-2 flex justify-center">
                  <StatusBadge value={status} />
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
};

export default Dashboard;
