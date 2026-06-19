// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import * as React from 'react';
import { cn } from '@/lib/utils';

// Happy Technologies eyebrow: the uppercase section-label chip that sits
// above page titles throughout the consoles.
const toneMap = {
  accent: 'bg-sky-soft text-sky-text',
  coral: 'bg-coral-soft text-coral-dark',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-line-soft text-ink-soft',
} as const;

export interface EyebrowProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: keyof typeof toneMap;
}

const Eyebrow = React.forwardRef<HTMLSpanElement, EyebrowProps>(
  ({ tone = 'accent', className, children, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'inline-block rounded-sm px-3 py-1.5 font-display text-xs font-bold uppercase tracking-[0.13em]',
        toneMap[tone],
        className
      )}
      {...props}
    >
      {children}
    </span>
  )
);
Eyebrow.displayName = 'Eyebrow';

export { Eyebrow };
