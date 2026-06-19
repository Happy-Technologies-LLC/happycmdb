// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { cn } from '@/lib/utils';

interface LiquidGlassProps {
  children: React.ReactNode;
  className?: string;
  /** Padding size preset @default 'md' */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Border radius preset @default 'lg' */
  rounded?: 'none' | 'md' | 'lg' | 'xl' | '2xl' | '3xl';
  /** Lift + deepen shadow on hover @default false */
  hover?: boolean;
  /** Surface tint @default 'default' */
  variant?: 'default' | 'primary' | 'secondary' | 'muted' | 'accent';
  /** Optional click handler */
  onClick?: () => void;
}

// NOTE: This was a glassmorphism wrapper; it has been re-skinned to the
// Happy Technologies card (white surface, hairline border, soft navy-tinted
// shadow, optional hover lift). The prop surface is unchanged so every
// existing call site adopts the brand with no edits.

const sizeMap: Record<NonNullable<LiquidGlassProps['size']>, string> = {
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
  xl: 'p-8',
};

const roundedMap: Record<NonNullable<LiquidGlassProps['rounded']>, string> = {
  none: 'rounded-none',
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  '2xl': 'rounded-xl',
  '3xl': 'rounded-xl',
};

const variantMap: Record<NonNullable<LiquidGlassProps['variant']>, string> = {
  default: 'bg-card border-line',
  primary: 'bg-sky-soft border-sky/20',
  secondary: 'bg-warm-alt border-line',
  muted: 'bg-warm border-line',
  accent: 'bg-sky-soft border-sky/20',
};

export const LiquidGlass: React.FC<LiquidGlassProps> = ({
  children,
  className,
  size = 'md',
  rounded = 'lg',
  hover = false,
  variant = 'default',
  onClick,
}) => {
  return (
    <div
      className={cn(
        'relative border shadow-sm transition-all duration-300 ease-out',
        sizeMap[size],
        roundedMap[rounded],
        variantMap[variant],
        hover && 'hover:-translate-y-0.5 hover:shadow-lg hover:border-transparent',
        onClick && 'cursor-pointer',
        className
      )}
      onClick={onClick}
    >
      {children}
    </div>
  );
};

LiquidGlass.displayName = 'LiquidGlass';
