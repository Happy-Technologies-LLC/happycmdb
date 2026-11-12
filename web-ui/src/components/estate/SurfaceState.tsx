// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { Button, EmptyState } from '@happy-technologies/design-system';
import { classifyError } from '@/lib/estate';

/** A read that is loading, refused (403, with the server's reason), failed, or answered with nothing. */
export function QueryState({
  what,
  loading,
  error,
  onRetry,
}: {
  /** What the surface shows, in the sentence "Could not load {what}". */
  what: string;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  if (loading) return <EmptyState loading label={`Loading ${what}…`} />;
  const failure = classifyError(error);
  if (failure.kind === 'forbidden') {
    return (
      <EmptyState
        tone="danger"
        icon="lock-key"
        title={`No access to ${what}`}
        description={failure.message}
      />
    );
  }
  return (
    <EmptyState
      tone="danger"
      icon="warning-circle"
      title={`Could not load ${what}`}
      description={failure.message}
      action={
        onRetry ? (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        ) : undefined
      }
    />
  );
}

/** A function whose backend is not on main yet: says what is missing, shows no number. */
export function NotShipped({
  title,
  missing,
  action,
}: {
  title: string;
  missing: ReactNode;
  action?: ReactNode;
}) {
  return <EmptyState icon="hourglass-medium" title={title} description={missing} action={action} />;
}
