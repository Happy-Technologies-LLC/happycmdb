// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Badge, Icon, type BadgeVariant } from '@happy-technologies/design-system';
import { CIStatus } from '../../services/ci.service';

interface CIStatusBadgeProps {
  status: CIStatus;
  /** Retained for callers: the design-system Badge has one size, so this no longer changes the geometry. */
  size?: 'small' | 'medium';
  /** `filled` (default) renders the heavier lifecycle label weight; `outlined` the regular one. */
  variant?: 'filled' | 'outlined';
  className?: string;
}

/** Lifecycle status. Health is a separate signal (`CI.health`) and never reads from this badge. */
const statusConfig: Record<
  CIStatus,
  { label: string; tone: BadgeVariant; icon: React.ReactElement }
> = {
  active: { label: 'Active', tone: 'success', icon: <Icon name="check-circle" size={13} /> },
  inactive: { label: 'Inactive', tone: 'neutral', icon: <Icon name="x" size={13} /> },
  maintenance: { label: 'Maintenance', tone: 'warning', icon: <Icon name="wrench" size={13} /> },
  decommissioned: { label: 'Decommissioned', tone: 'danger', icon: <Icon name="trash" size={13} /> },
};

export const CIStatusBadge: React.FC<CIStatusBadgeProps> = ({
  status,
  variant = 'filled',
  className,
}) => {
  const config = statusConfig[status] || statusConfig.inactive;
  return (
    <Badge
      variant={config.tone}
      emphasis={variant === 'filled' ? 'bold' : 'medium'}
      className={className}
    >
      {config.icon}
      {config.label}
    </Badge>
  );
};

export default CIStatusBadge;
