// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

// Happy Technologies brand button. Primary is sky-blue; `cta` is coral and
// reserved for conversion-style primary actions. Variant names stay
// backwards-compatible with the prior shadcn set so call sites are unchanged.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-display text-sm font-bold tracking-[0.01em] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-sky text-white shadow-sm hover:bg-sky-light',
        cta: 'bg-coral text-white shadow-md hover:bg-coral-dark hover:shadow-lg',
        destructive: 'bg-danger text-white shadow-sm hover:opacity-90',
        outline: 'border-2 border-navy bg-transparent text-navy hover:bg-navy hover:text-white',
        secondary: 'bg-warm-alt text-navy hover:bg-line',
        ghost: 'bg-transparent text-sky-text hover:bg-sky-soft',
        link: 'text-sky-text underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-5 py-2',
        sm: 'h-9 rounded-md px-4 text-xs',
        lg: 'h-12 rounded-md px-7 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
