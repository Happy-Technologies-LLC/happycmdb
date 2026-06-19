// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import {
  CheckCircle,
  X,
  Wrench,
  Trash2,
} from 'lucide-react';
import { CIStatus } from '../../services/ci.service';
import { cn } from '../../utils/cn';

interface CIStatusBadgeProps {
  status: CIStatus;
  size?: 'small' | 'medium';
  variant?: 'filled' | 'outlined';
  className?: string;
}

const statusConfig: Record<
  CIStatus,
  {
    label: string;
    filled: string;
    outlined: string;
    icon: React.ReactElement;
  }
> = {
  active: {
    label: 'Active',
    filled: 'bg-success text-white border-success',
    outlined: 'bg-success-soft text-success border-success',
    icon: <CheckCircle className="w-4 h-4" />,
  },
  inactive: {
    label: 'Inactive',
    filled: 'bg-ink-soft text-white border-ink-soft',
    outlined: 'bg-line-soft text-ink-soft border-line',
    icon: <X className="w-4 h-4" />,
  },
  maintenance: {
    label: 'Maintenance',
    filled: 'bg-warning text-white border-warning',
    outlined: 'bg-warning-soft text-warning-text border-warning',
    icon: <Wrench className="w-4 h-4" />,
  },
  decommissioned: {
    label: 'Decommissioned',
    filled: 'bg-danger text-white border-danger',
    outlined: 'bg-danger-soft text-danger border-danger',
    icon: <Trash2 className="w-4 h-4" />,
  },
};

export const CIStatusBadge: React.FC<CIStatusBadgeProps> = ({
  status,
  size = 'small',
  variant = 'filled',
  className,
}) => {
  const config = statusConfig[status] || statusConfig.inactive;
  const colorClasses = variant === 'filled' ? config.filled : config.outlined;
  const sizeClasses = size === 'small' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-display font-semibold',
        colorClasses,
        sizeClasses,
        className
      )}
    >
      {config.icon}
      {config.label}
    </span>
  );
};

export default CIStatusBadge;
