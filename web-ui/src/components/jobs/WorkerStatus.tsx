// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * WorkerStatus Component
 *
 * Table showing worker status including concurrency and active jobs for each queue.
 */

import React from 'react';
import { Icon } from '@happy-technologies/design-system';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Progress } from '../ui/progress';
import { QueueMetrics, QueueHealth } from '../../services/jobs.service';
import { QueueHealthIndicator } from './QueueHealthIndicator';

interface WorkerStatusProps {
  metrics: QueueMetrics[];
  health: QueueHealth[];
  loading?: boolean;
  onPauseQueue?: (queueName: string) => Promise<void>;
  onResumeQueue?: (queueName: string) => Promise<void>;
}

export const WorkerStatus: React.FC<WorkerStatusProps> = ({
  metrics,
  health,
  loading = false,
  onPauseQueue,
  onResumeQueue,
}) => {
  const getQueueHealth = (queueName: string): QueueHealth | undefined => {
    return health.find((h) => h.queueName === queueName);
  };

  const getUtilization = (active: number, concurrency: number): number => {
    if (concurrency === 0) return 0;
    return (active / concurrency) * 100;
  };

  const handleTogglePause = async (queueName: string, isPaused: boolean) => {
    try {
      if (isPaused && onResumeQueue) {
        await onResumeQueue(queueName);
      } else if (!isPaused && onPauseQueue) {
        await onPauseQueue(queueName);
      }
    } catch (error) {
      console.error('Failed to toggle queue pause state:', error);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-4">
          <div className="h-72 bg-muted animate-pulse rounded" />
        </CardContent>
      </Card>
    );
  }

  if (metrics.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="text-center py-8">
            <h3 className="text-lg font-semibold text-muted-foreground">
              No worker data available
            </h3>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Queue Name</TableHead>
            <TableHead>Health</TableHead>
            <TableHead className="text-center">Active Workers</TableHead>
            <TableHead className="text-center">Total Workers</TableHead>
            <TableHead className="text-center">Concurrency</TableHead>
            <TableHead>Worker Utilization</TableHead>
            <TableHead className="text-center">Throughput (1h)</TableHead>
            <TableHead className="text-center">Error Rate</TableHead>
            <TableHead className="text-center">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {metrics.map((metric) => {
            const queueHealth = getQueueHealth(metric.queueName);
            const utilization = getUtilization(
              metric.workers.active,
              metric.workers.concurrency
            );

            const utilizationColor =
              utilization > 90 ? 'bg-red-600' :
              utilization > 70 ? 'bg-yellow-600' :
              'bg-blue-600';

            return (
              <TableRow key={metric.queueName}>
                <TableCell>
                  <div className="font-medium text-sm">
                    {metric.queueName}
                  </div>
                </TableCell>
                <TableCell>
                  {queueHealth && (
                    <QueueHealthIndicator health={queueHealth} />
                  )}
                </TableCell>
                <TableCell className="text-center">
                  <Badge
                    variant={metric.workers.active > 0 ? 'default' : 'outline'}
                    className="text-xs"
                  >
                    {metric.workers.active}
                  </Badge>
                </TableCell>
                <TableCell className="text-center">
                  <div className="text-sm">
                    {metric.workers.total}
                  </div>
                </TableCell>
                <TableCell className="text-center">
                  <div className="text-sm">
                    {metric.workers.concurrency}
                  </div>
                </TableCell>
                <TableCell className="min-w-[200px]">
                  <div className="flex items-center gap-2">
                    <div className="flex-grow">
                      <Progress
                        value={Math.min(utilization, 100)}
                        className="h-2"
                      />
                    </div>
                    <span className="text-sm text-muted-foreground min-w-[45px] text-right">
                      {utilization.toFixed(0)}%
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-center">
                  <div>
                    <div className="text-sm text-green-600">
                      {metric.throughput.completed.toLocaleString()}
                    </div>
                    {metric.throughput.failed > 0 && (
                      <div className="text-xs text-red-600">
                        {metric.throughput.failed} failed
                      </div>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-center">
                  {queueHealth && (
                    <Badge
                      variant={
                        queueHealth.errorRate > 0.1 ? 'destructive' :
                        queueHealth.errorRate > 0.05 ? 'secondary' :
                        'default'
                      }
                      className="text-xs"
                    >
                      {(queueHealth.errorRate * 100).toFixed(1)}%
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-center">
                  {queueHealth && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        handleTogglePause(metric.queueName, queueHealth.isPaused)
                      }
                      title={queueHealth.isPaused ? 'Resume Queue' : 'Pause Queue'}
                      className="gap-1"
                    >
                      {queueHealth.isPaused ? (
                        <Icon name="play" size={16} className="text-green-600" />
                      ) : (
                        <Icon name="pause" size={16} className="text-yellow-600" />
                      )}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
};
