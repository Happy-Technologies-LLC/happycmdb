// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Icon } from '@happy-technologies/design-system';
import { cn } from '@/lib/utils';

interface LoadingSpinnerProps {
  message?: string;
  size?: number;
  fullScreen?: boolean;
  className?: string;
}

const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({
  message = 'Loading...',
  size = 40,
  fullScreen = true,
  className,
}) => {
  const content = (
    <div className={cn('flex flex-col items-center justify-center gap-4', className)}>
      <Icon name="spinner-gap" size={size} className="animate-spin text-primary" />
      {message && (
        <p className="text-sm text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );

  if (fullScreen) {
    return (
      <div className="flex items-center justify-center min-h-screen w-full bg-background">
        {content}
      </div>
    );
  }

  return content;
};

export default LoadingSpinner;
