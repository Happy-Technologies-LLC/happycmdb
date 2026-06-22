// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * JobCancelButton Component
 *
 * Button to cancel a running or waiting job with confirmation dialog.
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

interface JobCancelButtonProps {
  job: Job;
  onCancel: (jobId: string) => Promise<void>;
  disabled?: boolean;
  variant?: 'default' | 'outline' | 'ghost' | 'secondary' | 'destructive';
  size?: 'sm' | 'default' | 'lg';
}

export const JobCancelButton: React.FC<JobCancelButtonProps> = ({
  job,
  onCancel,
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
      await onCancel(job.id);
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel job');
    } finally {
      setLoading(false);
    }
  };

  const canCancel = job.status === 'active' || job.status === 'waiting' || job.status === 'delayed';

  return (
    <>
      <Button
        variant={variant}
        size={size}
        onClick={handleOpen}
        disabled={disabled || !canCancel}
        title={canCancel ? 'Cancel this job' : 'Cannot cancel this job'}
        className="gap-1 text-destructive hover:text-destructive"
      >
        <Icon name="x-circle" size={16} />
        Cancel
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel Job</DialogTitle>
            <DialogDescription>
              Are you sure you want to cancel this job? This action cannot be undone.
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
                <strong>Status:</strong> {job.status}
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
              No, Keep Job
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirm}
              disabled={loading}
              className="gap-1"
            >
              {loading ? (
                <>
                  <Icon name="spinner-gap" size={16} className="animate-spin" />
                  Canceling...
                </>
              ) : (
                <>
                  <Icon name="x-circle" size={16} />
                  Yes, Cancel Job
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
