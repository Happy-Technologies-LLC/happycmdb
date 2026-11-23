// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * JobRetryButton Component
 *
 * Button to retry a failed job with confirmation dialog.
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

interface JobRetryButtonProps {
  job: Job;
  onRetry: (jobId: string) => Promise<void>;
  disabled?: boolean;
  variant?: 'default' | 'outline' | 'ghost' | 'secondary';
  size?: 'sm' | 'default' | 'lg';
}

const VARIANT: Record<NonNullable<JobRetryButtonProps['variant']>, ButtonVariant> = {
  default: 'primary',
  outline: 'outline',
  ghost: 'ghost',
  secondary: 'secondary',
};

const SIZE = { sm: 'sm', default: 'md', lg: 'lg' } as const;

export const JobRetryButton: React.FC<JobRetryButtonProps> = ({
  job,
  onRetry,
  disabled = false,
  variant = 'outline',
  size = 'sm',
}) => {
  // The server route (POST /jobs/:queue/:id/retry) is the authority; this only hides the control from read-only roles.
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
        variant={VARIANT[variant]}
        size={SIZE[size]}
        icon="arrow-clockwise"
        onClick={handleOpen}
        disabled={disabled || !canRetry}
        title={canRetry ? 'Retry this job' : 'Cannot retry this job'}
      >
        Retry
      </Button>

      <Dialog open={open} onClose={handleClose} aria-label="Retry Job">
        <div className="space-y-4 p-6">
          <SectionHeading className="mb-0! pr-8">Retry Job</SectionHeading>
          <p className="text-sm text-[var(--hh-text-body)]">Are you sure you want to retry this job?</p>
          <FieldList
            fields={[
              ['Job', job.name],
              ['Queue', job.queueName],
              ['Attempts', `${job.attempts} / ${job.maxAttempts}`],
            ]}
          />
          {error && <Banner tone="danger">Error: {error}</Banner>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={handleClose} disabled={loading}>
              Cancel
            </Button>
            <Button
              icon="arrow-clockwise"
              onClick={handleConfirm}
              loading={loading}
            >
              {loading ? 'Retrying...' : 'Retry'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
};
