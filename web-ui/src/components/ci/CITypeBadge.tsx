// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Badge, Icon } from '@happy-technologies/design-system';
import { CIType } from '../../services/ci.service';

interface CITypeBadgeProps {
  type: CIType;
  /** Retained for callers: the design-system Badge has one size, so this no longer changes the geometry. */
  size?: 'small' | 'medium';
  /** `filled` renders the heavier label weight; `outlined` (default) the regular one. */
  variant?: 'filled' | 'outlined';
  showIcon?: boolean;
  className?: string;
}

export const typeIcons: Record<CIType, React.ReactElement> = {
  server: <Icon name="computer-tower" size={16} />,
  'virtual-machine': <Icon name="cloud" size={16} />,
  container: <Icon name="cube" size={16} />,
  application: <Icon name="grid-four" size={16} />,
  service: <Icon name="code" size={16} />,
  database: <Icon name="database" size={16} />,
  'network-device': <Icon name="graph" size={16} />,
  storage: <Icon name="hard-drive" size={16} />,
  'load-balancer': <Icon name="scales" size={16} />,
  'cloud-resource': <Icon name="cloud-check" size={16} />,
};

export const typeLabels: Record<CIType, string> = {
  server: 'Server',
  'virtual-machine': 'Virtual Machine',
  container: 'Container',
  application: 'Application',
  service: 'Service',
  database: 'Database',
  'network-device': 'Network Device',
  storage: 'Storage',
  'load-balancer': 'Load Balancer',
  'cloud-resource': 'Cloud Resource',
};

export const CITypeBadge: React.FC<CITypeBadgeProps> = ({
  type,
  variant = 'outlined',
  showIcon = true,
  className,
}) => {
  const resolved: CIType = typeLabels[type] ? type : 'server';
  return (
    <Badge variant="info" emphasis={variant === 'filled' ? 'bold' : 'medium'} className={className}>
      {showIcon && typeIcons[resolved]}
      {typeLabels[resolved]}
    </Badge>
  );
};

export default CITypeBadge;
