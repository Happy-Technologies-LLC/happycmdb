// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * QueueStats Component
 *
 * Display queue statistics as cards showing active, waiting, completed, and failed counts.
 */

import React from 'react';
import { Icon } from '@happy-technologies/design-system';
import { Card, CardContent } from '../ui/card';
import { QueueStats as QueueStatsType } from '../../services/jobs.service';
import { cn } from '../../lib/utils';

interface QueueStatsProps {
  stats: QueueStatsType[];
  loading?: boolean;
  queueFilter?: string;
}

interface StatCardProps {
  title: string;
  value: number;
  icon: React.ReactNode;
  colorClass: string;
  loading?: boolean;
}

const StatCard: React.FC<StatCardProps> = ({ title, value, icon, colorClass, loading }) => {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center mb-3">
          <div className={cn(
            "flex items-center justify-center w-10 h-10 rounded mr-3",
            colorClass
          )}>
            {icon}
          </div>
          <span className="text-sm text-muted-foreground">
            {title}
          </span>
        </div>
        {loading ? (
          <div className="h-10 w-20 bg-muted animate-pulse rounded" />
        ) : (
          <div className="text-3xl font-bold">
            {value.toLocaleString()}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export const QueueStats: React.FC<QueueStatsProps> = ({
  stats,
  loading = false,
  queueFilter,
}) => {
  const filteredStats = queueFilter
    ? stats.filter((s) => s.queueName === queueFilter)
    : stats;

  const aggregatedStats = filteredStats.reduce(
    (acc, stat) => ({
      active: acc.active + stat.active,
      waiting: acc.waiting + stat.waiting,
      completed: acc.completed + stat.completed,
      failed: acc.failed + stat.failed,
      delayed: acc.delayed + stat.delayed,
      paused: acc.paused + stat.paused,
    }),
    {
      active: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
    }
  );

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      <StatCard
        title="Active"
        value={aggregatedStats.active}
        icon={<Icon name="play" size={20} className="text-primary" />}
        colorClass="bg-blue-100"
        loading={loading}
      />
      <StatCard
        title="Waiting"
        value={aggregatedStats.waiting}
        icon={<Icon name="hourglass" size={20} className="text-yellow-700" />}
        colorClass="bg-yellow-100"
        loading={loading}
      />
      <StatCard
        title="Completed"
        value={aggregatedStats.completed}
        icon={<Icon name="check-circle" size={20} className="text-green-700" />}
        colorClass="bg-green-100"
        loading={loading}
      />
      <StatCard
        title="Failed"
        value={aggregatedStats.failed}
        icon={<Icon name="x-circle" size={20} className="text-red-700" />}
        colorClass="bg-red-100"
        loading={loading}
      />
      <StatCard
        title="Delayed"
        value={aggregatedStats.delayed}
        icon={<Icon name="clock" size={20} className="text-primary" />}
        colorClass="bg-blue-100"
        loading={loading}
      />
      <StatCard
        title="Paused"
        value={aggregatedStats.paused}
        icon={<Icon name="pause" size={20} className="text-foreground" />}
        colorClass="bg-muted"
        loading={loading}
      />
    </div>
  );
};
