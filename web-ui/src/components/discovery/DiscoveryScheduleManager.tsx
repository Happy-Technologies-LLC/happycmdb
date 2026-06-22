// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React, { useState, useEffect } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { DiscoverySchedule, DiscoveryProvider } from '../../services/discovery.service';
import { useDiscovery } from '../../hooks/useDiscovery';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { Badge } from '../ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { LiquidGlass } from '../ui/liquid-glass';
import { CronBuilder } from '../ui/cron-builder';

interface ScheduleEditDialogProps {
  open: boolean;
  schedule: DiscoverySchedule | null;
  onClose: () => void;
  onSave: (provider: DiscoveryProvider, enabled: boolean, cron: string) => void;
}

const ScheduleEditDialog: React.FC<ScheduleEditDialogProps> = ({
  open,
  schedule,
  onClose,
  onSave,
}) => {
  const [enabled, setEnabled] = useState(true);
  const [cronExpression, setCronExpression] = useState('0 * * * *');

  useEffect(() => {
    if (schedule) {
      setEnabled(schedule.enabled);
      setCronExpression(schedule.cronExpression);
    }
  }, [schedule]);

  const handleSave = () => {
    if (schedule) {
      onSave(schedule.provider, enabled, cronExpression);
      onClose();
    }
  };

  const handleCronChange = (newCron: string) => {
    setCronExpression(newCron);
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            Edit Schedule - {schedule?.provider.toUpperCase()}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-6 py-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="enable-schedule">Enable Schedule</Label>
            <Switch
              id="enable-schedule"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          </div>

          {enabled && (
            <CronBuilder value={cronExpression} onChange={handleCronChange} />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const DiscoveryScheduleManager: React.FC = () => {
  const { schedules, loadSchedules, updateSchedule, loading } = useDiscovery();
  const [editDialog, setEditDialog] = useState<{
    open: boolean;
    schedule: DiscoverySchedule | null;
  }>({ open: false, schedule: null });

  useEffect(() => {
    loadSchedules();
  }, [loadSchedules]);

  const handleEdit = (schedule: DiscoverySchedule) => {
    setEditDialog({ open: true, schedule });
  };

  const handleSave = async (
    provider: DiscoveryProvider,
    enabled: boolean,
    cron: string
  ) => {
    await updateSchedule(provider, { enabled, cronExpression: cron });
    loadSchedules();
  };

  const formatRelativeTime = (dateString?: string): string => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    const diffMins = Math.floor(Math.abs(diffMs) / 60000);

    if (diffMs < 0) {
      if (diffMins < 60) return `${diffMins}m ago`;
      const hours = Math.floor(diffMins / 60);
      if (hours < 24) return `${hours}h ago`;
      return `${Math.floor(hours / 24)}d ago`;
    } else {
      if (diffMins < 60) return `in ${diffMins}m`;
      const hours = Math.floor(diffMins / 60);
      if (hours < 24) return `in ${hours}h`;
      return `in ${Math.floor(hours / 24)}d`;
    }
  };

  const getCronDescription = (cronExpression: string): string => {
    const parts = cronExpression.split(' ');
    if (parts.length !== 5) return cronExpression;

    const [min, hour, day, month, weekday] = parts;
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    // Every minute
    if (min === '*' && hour === '*') {
      return 'Every minute';
    }

    // Every hour
    if (hour === '*' && day === '*' && weekday === '*') {
      return `Every hour at ${min} minutes past`;
    }

    // Daily
    if (day === '*' && weekday === '*') {
      const timeStr = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
      return `Every day at ${timeStr}`;
    }

    // Weekly
    if (day === '*' && weekday !== '*') {
      const timeStr = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
      const dayName = days[parseInt(weekday)] || weekday;
      return `Every ${dayName} at ${timeStr}`;
    }

    // Monthly
    if (day !== '*') {
      const timeStr = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
      return `Day ${day} of every month at ${timeStr}`;
    }

    return cronExpression;
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">Discovery Schedules</h3>
        <p className="text-sm text-muted-foreground">
          Configure automated discovery schedules for each provider
        </p>
      </div>

      <LiquidGlass size="sm" rounded="xl" className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Last Run</TableHead>
              <TableHead>Next Run</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center">
                  Loading schedules...
                </TableCell>
              </TableRow>
            ) : schedules.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground">
                  No schedules found
                </TableCell>
              </TableRow>
            ) : (
              schedules.map((schedule) => (
                <TableRow key={schedule.provider}>
                  <TableCell className="font-medium uppercase">
                    {schedule.provider}
                  </TableCell>
                  <TableCell>
                    <Badge variant={schedule.enabled ? 'default' : 'secondary'}>
                      {schedule.enabled ? 'Enabled' : 'Disabled'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {getCronDescription(schedule.cronExpression)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {formatRelativeTime(schedule.lastRun)}
                  </TableCell>
                  <TableCell className="text-sm text-primary">
                    {formatRelativeTime(schedule.nextRun)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEdit(schedule)}
                    >
                      <Icon name="pencil-simple" size={16} className="mr-2" />
                      Edit
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </LiquidGlass>

      <ScheduleEditDialog
        open={editDialog.open}
        schedule={editDialog.schedule}
        onClose={() => setEditDialog({ open: false, schedule: null })}
        onSave={handleSave}
      />
    </div>
  );
};

export default DiscoveryScheduleManager;
