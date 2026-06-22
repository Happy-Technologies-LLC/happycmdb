// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ScheduleToggle Component
 *
 * Toggle switch to enable/disable job schedules.
 */

import React, { useState } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { Switch } from '../ui/switch';
import { JobSchedule } from '../../services/jobs.service';

interface ScheduleToggleProps {
  schedule: JobSchedule;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
}

export const ScheduleToggle: React.FC<ScheduleToggleProps> = ({
  schedule,
  onToggle,
}) => {
  const [loading, setLoading] = useState(false);
  const [enabled, setEnabled] = useState(schedule.enabled);

  const handleToggle = async (checked: boolean) => {
    try {
      setLoading(true);
      await onToggle(schedule.id, checked);
      setEnabled(checked);
    } catch (error) {
      console.error('Failed to toggle schedule:', error);
      // Revert the change on error
      setEnabled(!checked);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="inline-flex items-center" title={enabled ? 'Disable schedule' : 'Enable schedule'}>
      {loading ? (
        <Icon name="spinner-gap" size={20} className="animate-spin" />
      ) : (
        <Switch
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={loading}
        />
      )}
    </div>
  );
};
