// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

// Happy Technologies text field: warm-bg fill, 2px hairline that turns
// sky on focus with a soft glow, brand radius.
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-11 w-full rounded-md border-2 border-line bg-warm px-4 py-2 text-sm text-ink transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
