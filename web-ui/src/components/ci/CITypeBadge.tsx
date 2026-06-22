// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Icon } from '@happy-technologies/design-system';
import { CIType } from '../../services/ci.service';
import { cn } from '../../utils/cn';

interface CITypeBadgeProps {
  type: CIType;
  size?: 'small' | 'medium';
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

const typeConfig: Record<CIType, { label: string; icon: React.ReactElement }> = {
  server: { label: 'Server', icon: typeIcons.server },
  'virtual-machine': { label: 'Virtual Machine', icon: typeIcons['virtual-machine'] },
  container: { label: 'Container', icon: typeIcons.container },
  application: { label: 'Application', icon: typeIcons.application },
  service: { label: 'Service', icon: typeIcons.service },
  database: { label: 'Database', icon: typeIcons.database },
  'network-device': { label: 'Network Device', icon: typeIcons['network-device'] },
  storage: { label: 'Storage', icon: typeIcons.storage },
  'load-balancer': { label: 'Load Balancer', icon: typeIcons['load-balancer'] },
  'cloud-resource': { label: 'Cloud Resource', icon: typeIcons['cloud-resource'] },
};

export const CITypeBadge: React.FC<CITypeBadgeProps> = ({
  type,
  size = 'small',
  variant = 'outlined',
  showIcon = true,
  className,
}) => {
  const config = typeConfig[type] || typeConfig.server;
  const colorClasses =
    variant === 'filled'
      ? 'bg-sky text-white border-sky'
      : 'bg-sky-soft text-sky-text border-sky';
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
      {showIcon && config.icon}
      {config.label}
    </span>
  );
};

export default CITypeBadge;
