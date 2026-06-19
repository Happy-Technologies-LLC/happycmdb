// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import * as React from 'react';

import { cn } from '@/lib/utils';

// Matches the brand Input: warm fill, sky focus glow, brand radius.
const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          'flex min-h-[80px] w-full resize-y rounded-md border-2 border-line bg-warm px-4 py-3 text-sm text-ink transition-all placeholder:text-ink-soft/70 focus-visible:border-sky focus-visible:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sky/10 disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';

export { Textarea };
