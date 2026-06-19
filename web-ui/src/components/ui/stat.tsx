// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import * as React from 'react';
import { cn } from '@/lib/utils';

// Happy Technologies "proof number": oversized sky-text figure in Inter
// extrabold with a small label beneath.
export interface StatProps extends React.HTMLAttributes<HTMLDivElement> {
  value: React.ReactNode;
  label: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  align?: 'center' | 'left';
}

const valueSize: Record<NonNullable<StatProps['size']>, string> = {
  sm: 'text-[1.75rem]',
  md: 'text-[2.5rem]',
  lg: 'text-[3.5rem]',
};

const Stat = React.forwardRef<HTMLDivElement, StatProps>(
  ({ value, label, size = 'md', align = 'center', className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(align === 'center' ? 'text-center' : 'text-left', className)}
      {...props}
    >
      <div
        className={cn(
          'font-display font-extrabold leading-none tracking-[-0.01em] text-sky-text',
          valueSize[size]
        )}
      >
        {value}
      </div>
      <div className="mt-1.5 font-display text-xs font-semibold text-ink-soft">{label}</div>
    </div>
  )
);
Stat.displayName = 'Stat';

export { Stat };
