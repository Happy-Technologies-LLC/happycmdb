// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import * as React from 'react';
import { cn } from '@/lib/utils';

// Happy Technologies icon button: square/circular control wrapping a single
// icon passed as children. Used for toolbar and topbar actions.
const variantMap = {
  solid: 'bg-sky text-white hover:bg-sky-light',
  soft: 'bg-sky-soft text-sky-text hover:bg-sky-soft/70',
  outline: 'border-2 border-line text-sky-text hover:border-sky',
  ghost: 'text-ink-soft hover:bg-line-soft',
} as const;

const sizeMap = {
  sm: 'h-9 w-9 [&_svg]:size-4',
  md: 'h-11 w-11 [&_svg]:size-5',
  lg: 'h-13 w-13 [&_svg]:size-6',
} as const;

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variantMap;
  size?: keyof typeof sizeMap;
  shape?: 'rounded' | 'circle';
  label: string;
}

const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    { variant = 'soft', size = 'md', shape = 'rounded', label, className, children, ...props },
    ref
  ) => (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className={cn(
        'inline-flex items-center justify-center transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 [&_svg]:shrink-0',
        shape === 'circle' ? 'rounded-full' : 'rounded-md',
        variantMap[variant],
        sizeMap[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
);
IconButton.displayName = 'IconButton';

export { IconButton };
