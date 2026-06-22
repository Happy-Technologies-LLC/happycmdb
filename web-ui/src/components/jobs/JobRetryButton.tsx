// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * JobRetryButton Component
 *
 * Button to retry a failed job with confirmation dialog.
 */

import React, { useState } from 'react';
import { Icon } from '@happy-technologies/design-system';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Job } from '../../services/jobs.service';

interface JobRetryButtonProps {
  job: Job;
  onRetry: (jobId: string) => Promise<void>;
  disabled?: boolean;
  variant?: 'default' | 'outline' | 'ghost' | 'secondary';
  size?: 'sm' | 'default' | 'lg';
}

export const JobRetryButton: React.FC<JobRetryButtonProps> = ({
  job,
  onRetry,
  disabled = false,
  variant = 'outline',
  size = 'sm',
}) => {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpen = () => {
    setOpen(true);
    setError(null);
  };

  const handleClose = () => {
    setOpen(false);
    setError(null);
  };

  const handleConfirm = async () => {
    try {
      setLoading(true);
      setError(null);
      await onRetry(job.id);
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry job');
    } finally {
      setLoading(false);
    }
  };

  const canRetry = job.status === 'failed' && job.attempts < job.maxAttempts;

  return (
    <>
      <Button
        variant={variant}
        size={size}
        onClick={handleOpen}
        disabled={disabled || !canRetry}
        title={canRetry ? 'Retry this job' : 'Cannot retry this job'}
        className="gap-1"
      >
        <Icon name="arrow-clockwise" size={16} />
        Retry
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Retry Job</DialogTitle>
            <DialogDescription>
              Are you sure you want to retry this job?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <div className="grid gap-1">
              <span className="text-sm">
                <strong>Job:</strong> {job.name}
              </span>
              <span className="text-sm">
                <strong>Queue:</strong> {job.queueName}
              </span>
              <span className="text-sm">
                <strong>Attempts:</strong> {job.attempts} / {job.maxAttempts}
              </span>
            </div>
            {error && (
              <div className="text-sm text-destructive mt-2">
                Error: {error}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleClose}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={loading}
              className="gap-1"
            >
              {loading ? (
                <>
                  <Icon name="spinner-gap" size={16} className="animate-spin" />
                  Retrying...
                </>
              ) : (
                <>
                  <Icon name="arrow-clockwise" size={16} />
                  Retry
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
