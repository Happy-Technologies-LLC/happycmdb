// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * JobCancelButton Component
 *
 * Button to cancel a running or waiting job with confirmation dialog.
 */

import React, { useState } from 'react';
import {
  Banner,
  Button,
  Dialog,
  FieldList,
  SectionHeading,
  type ButtonVariant,
} from '@happy-technologies/design-system';
import { usePermission } from '@/hooks/usePermission';
import { Job } from '../../services/jobs.service';

interface JobCancelButtonProps {
  job: Job;
  onCancel: (jobId: string) => Promise<void>;
  disabled?: boolean;
  variant?: 'default' | 'outline' | 'ghost' | 'secondary' | 'destructive';
  size?: 'sm' | 'default' | 'lg';
}

const VARIANT: Record<NonNullable<JobCancelButtonProps['variant']>, ButtonVariant> = {
  default: 'primary',
  outline: 'outline',
  ghost: 'ghost',
  secondary: 'secondary',
  destructive: 'danger',
};

const SIZE = { sm: 'sm', default: 'md', lg: 'lg' } as const;

export const JobCancelButton: React.FC<JobCancelButtonProps> = ({
  job,
  onCancel,
  disabled = false,
  variant = 'outline',
  size = 'sm',
}) => {
  // The server route (DELETE /jobs/:queue/:id) is the authority; this only hides the control from read-only roles.
  const canWrite = usePermission('write');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canWrite) return null;

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
        variant={VARIANT[variant]}
        size={SIZE[size]}
        icon="x-circle"
        onClick={handleOpen}
        disabled={disabled || !canCancel}
        title={canCancel ? 'Cancel this job' : 'Cannot cancel this job'}
      >
        Cancel
      </Button>

      <Dialog open={open} onClose={handleClose} aria-label="Cancel Job">
        <div className="space-y-4 p-6">
          <SectionHeading className="mb-0 pr-8">Cancel Job</SectionHeading>
          <p className="text-sm text-[var(--hh-text-body)]">
            Are you sure you want to cancel this job? This action cannot be undone.
          </p>
          <FieldList
            fields={[
              ['Job', job.name],
              ['Queue', job.queueName],
              ['Status', job.status],
            ]}
          />
          {error && <Banner tone="danger">Error: {error}</Banner>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={handleClose} disabled={loading}>
              No, Keep Job
            </Button>
            <Button
              variant="danger"
              icon="x-circle"
              onClick={handleConfirm}
              loading={loading}
            >
              {loading ? 'Canceling...' : 'Yes, Cancel Job'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
};
