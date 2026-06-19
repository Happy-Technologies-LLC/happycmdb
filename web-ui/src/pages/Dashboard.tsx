// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import {
  Computer,
  CheckCircle,
  AlertTriangle,
  TrendingUp,
  Cloud,
  HardDrive,
  AppWindow,
  Radar,
  Database,
  LucideIcon,
} from 'lucide-react';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/eyebrow';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { brand, chartSeries } from '@/lib/brandColors';
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

interface KpiCardProps {
  icon: LucideIcon;
  value: React.ReactNode;
  label: string;
  accent?: string;
  onClick?: () => void;
}

const KpiCard: React.FC<KpiCardProps> = ({
  icon: Icon,
  value,
  label,
  accent = brand.skyText,
  onClick,
}) => {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      className={
        'rounded-lg border border-line bg-card p-[22px] text-left shadow-sm transition-all' +
        (onClick ? ' cursor-pointer hover:-translate-y-0.5 hover:border-sky hover:shadow-md' : '')
      }
    >
      <span
        className="flex h-11 w-11 items-center justify-center rounded-md"
        style={{ backgroundColor: `${accent}1f` }}
      >
        <Icon className="h-6 w-6" style={{ color: accent }} />
      </span>
      <div className="mt-4 font-display text-[2.3rem] font-extrabold leading-none tracking-[-0.02em] text-navy">
        {value}
      </div>
      <div className="mt-[7px] font-display text-[12.5px] font-semibold text-ink-soft">{label}</div>
    </Comp>
  );
};

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
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Failed to load dashboard data. {(error as Error).message}
        </AlertDescription>
      </Alert>
    );
  }

  if (isLoading || !stats) {
    return (
      <div className="flex justify-center py-20">
        <div className="h-12 w-12 animate-spin rounded-full border-2 border-line border-t-sky" />
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

  const health =
    stats.health_score >= 0.8
      ? brand.success
      : stats.health_score >= 0.5
        ? brand.warning
        : brand.danger;

  return (
    <div className="mx-auto max-w-[1280px]">
      {/* Header */}
      <div className="mb-7 flex flex-wrap items-end justify-between gap-6">
        <div>
          <Eyebrow>Configuration Plane · Overview</Eyebrow>
          <h1 className="mt-3 text-[2.1rem]">CMDB Dashboard</h1>
          <p className="mt-1.5 max-w-xl text-[1.02rem] text-ink-soft">
            Your service graph is healthy. {stats.total_cis} configuration items reconciled across
            the estate.
          </p>
        </div>
        <div className="flex gap-3">
          <Button size="lg" onClick={() => navigate('/discovery')}>
            <Radar className="h-5 w-5" /> Run discovery
          </Button>
          <Button size="lg" variant="outline" onClick={() => navigate('/cis')}>
            <Database className="h-5 w-5" /> Inventory
          </Button>
        </div>
      </div>

      {/* KPI row */}
      <div className="mb-[22px] grid grid-cols-2 gap-[18px] lg:grid-cols-4">
        <KpiCard
          icon={Computer}
          value={stats.total_cis}
          label="Total configuration items"
          onClick={() => navigate('/cis')}
        />
        <KpiCard
          icon={CheckCircle}
          value={stats.by_status.active || 0}
          label="Active CIs"
          accent={brand.success}
          onClick={() => navigate('/cis?status=active')}
        />
        <KpiCard
          icon={TrendingUp}
          value={`${(stats.health_score * 100).toFixed(0)}%`}
          label="Health score"
          accent={health}
          onClick={() => navigate('/cmdb-health')}
        />
        <KpiCard
          icon={AlertTriangle}
          value={stats.critical_relationships}
          label="Critical relationships"
          accent={brand.warning}
          onClick={() => navigate('/anomalies')}
        />
      </div>

      {/* Distributions */}
      <div className="mb-[18px] grid gap-[18px] md:grid-cols-2">
        <LiquidGlass variant="default" size="lg" rounded="lg">
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
        </LiquidGlass>

        <LiquidGlass variant="default" size="lg" rounded="lg">
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
        </LiquidGlass>
      </div>

      {/* Types + recent */}
      <div className="mb-[18px] grid gap-[18px] md:grid-cols-3">
        <LiquidGlass variant="default" size="lg" rounded="lg" className="md:col-span-2">
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
        </LiquidGlass>

        <LiquidGlass variant="default" size="lg" rounded="lg">
          <h3 className="mb-4 text-[1.15rem]">Recent discoveries</h3>
          {stats.recent_discoveries.length > 0 ? (
            <div className="max-h-[350px] space-y-2 overflow-y-auto">
              {stats.recent_discoveries.map((ci) => (
                <button
                  key={ci.id}
                  className="flex w-full items-start gap-3 rounded-md border border-transparent p-3 text-left transition-colors hover:border-line hover:bg-warm"
                  onClick={() => navigate(`/cis/${ci.id}`)}
                >
                  <span className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-sm bg-sky-soft text-sky-text">
                    {ci.type === 'virtual-machine' ? (
                      <Cloud className="h-[18px] w-[18px]" />
                    ) : ci.type === 'database' ? (
                      <HardDrive className="h-[18px] w-[18px]" />
                    ) : ci.type === 'application' ? (
                      <AppWindow className="h-[18px] w-[18px]" />
                    ) : (
                      <Computer className="h-[18px] w-[18px]" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-display text-sm font-semibold text-navy">
                      {ci.name}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <CITypeBadge type={ci.type} size="small" />
                      <CIStatusBadge status={ci.status} size="small" />
                    </div>
                    {ci.last_discovered && (
                      <p className="mt-1 text-xs text-ink-soft">{formatDate(ci.last_discovered)}</p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="py-8 text-center text-ink-soft">No recent discoveries</p>
          )}
        </LiquidGlass>
      </div>

      {/* Status breakdown */}
      <LiquidGlass variant="default" size="lg" rounded="lg">
        <h3 className="mb-6 text-[1.15rem]">Status breakdown</h3>
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
          {Object.entries(stats.by_status).map(([status, count]) => {
            const color = STATUS_COLORS[status] || brand.inkSoft;
            return (
              <div key={status} className="rounded-lg border border-line bg-warm p-4 text-center">
                <p className="font-display text-3xl font-extrabold leading-none" style={{ color }}>
                  {count}
                </p>
                <span
                  className="mt-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-display text-xs font-semibold capitalize"
                  style={{ backgroundColor: `${color}1f`, color }}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
                  {status}
                </span>
              </div>
            );
          })}
        </div>
      </LiquidGlass>
    </div>
  );
};

export default Dashboard;
