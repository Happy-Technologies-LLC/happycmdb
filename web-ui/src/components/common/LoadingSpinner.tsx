// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { FullPageState, Spinner } from '@happy-technologies/design-system';
import { cn } from '@/lib/utils';

interface LoadingSpinnerProps {
  message?: string;
  size?: number;
  fullScreen?: boolean;
  className?: string;
}

export default function LoadingSpinner({
  message = 'Loading...',
  size = 40,
  fullScreen = true,
  className,
}: LoadingSpinnerProps) {
  if (fullScreen) return <FullPageState loading title={message} className={className} />;
  return (
    <div className={cn('flex flex-col items-center justify-center gap-4', className)}>
      <Spinner size={size} aria-label={message} />
      {message && <p className="text-sm text-[var(--hh-text-body)]">{message}</p>}
    </div>
  );
}
