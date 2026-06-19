// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

// Happy Technologies status pill: soft tinted background, colored text,
// pill radius. Tones map to the design-system semantic palette. Variant
// names are kept backwards-compatible with the prior shadcn set.
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border border-transparent px-2.5 py-0.5 font-display text-xs font-semibold tracking-[0.01em] transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-sky-soft text-sky-text',
        secondary: 'bg-line-soft text-ink-soft',
        destructive: 'bg-danger-soft text-danger',
        outline: 'border-line text-ink-soft',
        success: 'bg-success-soft text-success',
        warning: 'bg-warning-soft text-warning-text',
        info: 'bg-sky-soft text-sky-text',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
