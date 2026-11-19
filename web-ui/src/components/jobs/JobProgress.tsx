// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * JobProgress Component
 *
 * Visual progress bar showing job completion percentage and status.
 */

import React from 'react';
import {
  Icon,
  ProgressBar,
  type BadgeVariant,
  type ProgressTone,
} from '@happy-technologies/design-system';
import { Job } from '../../services/jobs.service';

interface JobProgressProps {
  job: Job;
  showLabel?: boolean;
  showIcon?: boolean;
  height?: number;
}

/** The DS badge tone of a job status. The status text always renders beside it: tone is never the only cue. */
export const jobStatusVariant = (status: Job['status']): BadgeVariant => {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'danger';
    case 'active':
      return 'info';
    case 'delayed':
      return 'warning';
    default:
      return 'neutral';
  }
};

const PROGRESS_TONE: Partial<Record<Job['status'], ProgressTone>> = {
  completed: 'success',
  failed: 'danger',
  waiting: 'warning',
  delayed: 'warning',
};

const ICON_TONE: Record<string, string> = {
  completed: 'text-[var(--hh-success-text)]',
  failed: 'text-[var(--hh-error-text)]',
  active: 'text-[var(--hh-accent-text)]',
  waiting: 'text-[var(--hh-warning-text)]',
  delayed: 'text-[var(--hh-warning-text)]',
  paused: 'text-[var(--hh-text-muted)]',
};

const ICON_NAME: Record<string, string> = {
  completed: 'check-circle',
  failed: 'x-circle',
  active: 'play',
  waiting: 'hourglass',
  delayed: 'hourglass',
  paused: 'pause',
};

/**
 * The percent to draw, or null when the job reports none. A finished job is 100. Any other job with no progress
 * figure (absent, not a number, or 0: jobsService maps every job with progress 0, it never receives one) has no
 * known progress, so no bar is drawn rather than a 0% bar that claims the job has not started.
 */
const knownProgress = (job: Job): number | null => {
  if (job.status === 'completed') return 100;
  const value: unknown = job.progress;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(100, value);
};

export const JobProgress: React.FC<JobProgressProps> = ({
  job,
  showLabel = true,
  showIcon = true,
  height = 8,
}) => {
  const iconName = ICON_NAME[job.status];
  const progressValue = knownProgress(job);
  const status = job.status.charAt(0).toUpperCase() + job.status.slice(1);

  return (
    <div className="w-full">
      {showLabel && (
        <div className="mb-1 flex items-center">
          {showIcon && iconName && (
            <div className="mr-2 flex items-center">
              <Icon name={iconName} size={16} className={ICON_TONE[job.status]} />
            </div>
          )}
          <span className="flex-grow text-sm text-[var(--hh-text-muted)]">{status}</span>
          {progressValue !== null && (
            <span className="text-sm text-[var(--hh-text-muted)]">{progressValue.toFixed(0)}%</span>
          )}
        </div>
      )}
      {progressValue !== null ? (
        <ProgressBar
          value={progressValue}
          tone={PROGRESS_TONE[job.status] ?? 'accent'}
          aria-label={`Progress of ${job.name}`}
          style={{ height: `${height}px` }}
        />
      ) : (
        !showLabel && <span className="text-sm text-[var(--hh-text-muted)]">-</span>
      )}
    </div>
  );
};
