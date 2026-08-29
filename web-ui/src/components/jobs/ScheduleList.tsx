// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ScheduleList Component
 *
 * List of scheduled jobs with cron expressions and next run times.
 */

import React from 'react';
import { format } from 'date-fns';
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
import { JobSchedule } from '../../services/jobs.service';
import { ScheduleToggle } from './ScheduleToggle';

interface ScheduleListProps {
  schedules: JobSchedule[];
  loading?: boolean;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
}

export const ScheduleList: React.FC<ScheduleListProps> = ({
  schedules,
  loading = false,
  onToggle,
}) => {
  const formatTimestamp = (timestamp: number): string => {
    return format(new Date(timestamp), 'MMM dd, yyyy HH:mm:ss');
  };

  const parseCron = (cron: string): string => {
    // Basic cron expression parser for display
    const parts = cron.split(' ');
    if (parts.length < 5) return cron;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    const descriptions: string[] = [];

    // Minute
    if (minute === '*') {
      descriptions.push('every minute');
    } else if (minute.startsWith('*/')) {
      descriptions.push(`every ${minute.slice(2)} minutes`);
    } else {
      descriptions.push(`at minute ${minute}`);
    }

    // Hour
    if (hour === '*') {
      descriptions.push('every hour');
    } else if (hour.startsWith('*/')) {
      descriptions.push(`every ${hour.slice(2)} hours`);
    } else {
      descriptions.push(`at ${hour}:00`);
    }

    // Day of month
    if (dayOfMonth !== '*') {
      descriptions.push(`on day ${dayOfMonth}`);
    }

    // Month
    if (month !== '*') {
      const monthNames = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
      ];
      const monthIndex = parseInt(month) - 1;
      if (monthIndex >= 0 && monthIndex < 12) {
        descriptions.push(`in ${monthNames[monthIndex]}`);
      }
    }

    // Day of week
    if (dayOfWeek !== '*') {
      const dayNames = [
        'Sunday',
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
        'Saturday',
      ];
      const dayIndex = parseInt(dayOfWeek);
      if (dayIndex >= 0 && dayIndex < 7) {
        descriptions.push(`on ${dayNames[dayIndex]}`);
      }
    }

    return descriptions.join(' ');
  };

  const getQueueType = (queueName: string): 'discovery' | 'etl' => {
    return queueName.startsWith('discovery-') ? 'discovery' : 'etl';
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-4">
          <div className="h-96 bg-muted animate-pulse rounded" />
        </CardContent>
      </Card>
    );
  }

  if (schedules.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="text-center py-8">
            <h3 className="text-lg font-semibold text-muted-foreground">
              No scheduled jobs
            </h3>
            <p className="text-sm text-muted-foreground mt-2">
              No recurring job schedules are configured
            </p>
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
            <TableHead>Schedule Name</TableHead>
            <TableHead>Queue</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Cron Expression</TableHead>
            <TableHead>Schedule Description</TableHead>
            <TableHead>Next Run</TableHead>
            <TableHead>Last Run</TableHead>
            <TableHead>Timezone</TableHead>
            <TableHead className="text-center">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {schedules.map((schedule) => (
            <TableRow key={schedule.id}>
              <TableCell>
                <div className="font-medium text-sm">
                  {schedule.name}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="text-xs">
                  {schedule.queueName}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge
                  variant={getQueueType(schedule.queueName) === 'discovery' ? 'default' : 'secondary'}
                  className="text-xs"
                >
                  {getQueueType(schedule.queueName)}
                </Badge>
              </TableCell>
              <TableCell>
                <code className="text-xs font-mono bg-muted px-2 py-1 rounded">
                  {schedule.cron}
                </code>
              </TableCell>
              <TableCell>
                <div className="text-sm text-muted-foreground">
                  {parseCron(schedule.cron)}
                </div>
              </TableCell>
              <TableCell>
                {schedule.nextRun ? (
                  <div className="text-sm">
                    {formatTimestamp(schedule.nextRun)}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    Not available
                  </div>
                )}
              </TableCell>
              <TableCell>
                {schedule.lastRun ? (
                  <div className="text-sm text-muted-foreground">
                    {formatTimestamp(schedule.lastRun)}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    Never
                  </div>
                )}
              </TableCell>
              <TableCell>
                <div className="text-sm text-muted-foreground">
                  {schedule.timezone || 'UTC'}
                </div>
              </TableCell>
              <TableCell className="text-center">
                <ScheduleToggle
                  schedule={schedule}
                  onToggle={onToggle}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
};
