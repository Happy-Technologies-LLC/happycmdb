// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { Icon } from '@happy-technologies/design-system';

/**
 * Connector icon mapping
 * Maps connector types to their respective icons
 *
 * For brand logos, we use Simple Icons via CDN:
 * https://simpleicons.org/
 */

// Type definition for connector icons
export type ConnectorIconProps = {
  className?: string;
  size?: number;
};

// Icon component map - returns React component for each connector
export const ConnectorIcons: Record<string, React.FC<ConnectorIconProps>> = {
  // ITSM / Asset Management
  'servicenow': ({ className, size = 24 }) => (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm-.5 17.5h-3v-3h3v3zm0-5h-3v-7h3v7zm4 5h-3v-5h3v5z"/>
    </svg>
  ),
  'jira': ({ className, size = 24 }) => (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z"/>
    </svg>
  ),
  'sccm': ({ className, size = 24 }) => (
    <Icon name="monitor" size={size} className={className} />
  ),
  'azure-ad': ({ className, size = 24 }) => (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.05 4.24L6.03 6.9v5.4c0 4.29 2.94 8.31 7.02 9.54 4.08-1.23 7.02-5.25 7.02-9.54V6.9l-7.02-2.66zm-.9 12.54v-6.3h6.3c-.24 3.48-2.49 6.51-6.3 7.2z"/>
    </svg>
  ),
  'okta': ({ className, size = 24 }) => (
    <Icon name="lock" size={size} className={className} />
  ),
  'intune': ({ className, size = 24 }) => (
    <Icon name="shield" size={size} className={className} />
  ),
  'jamf': ({ className, size = 24 }) => (
    <Icon name="monitor" size={size} className={className} />
  ),
  'tanium': ({ className, size = 24 }) => (
    <Icon name="pulse" size={size} className={className} />
  ),

  // Cloud Infrastructure
  'ibm-cloud': ({ className, size = 24 }) => (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M10.59 11.265h2.78c.33 0 .59.272.59.606v.003c0 .335-.26.607-.59.607h-2.78c-.33 0-.59-.272-.59-.607v-.003c0-.334.26-.606.59-.606zM9.412 9.5h5.153c.33 0 .588.272.588.607v.003c0 .334-.259.606-.588.606H9.412c-.329 0-.589-.272-.589-.606v-.003c0-.335.26-.607.589-.607z"/>
    </svg>
  ),
  'oracle-cloud': ({ className, size = 24 }) => (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M16.506 11.303c0-2.704-2.149-4.853-4.852-4.853-2.703 0-4.853 2.149-4.853 4.853s2.15 4.853 4.853 4.853c2.703 0 4.852-2.15 4.852-4.853zm-7.886 0c0-1.643 1.346-2.989 2.989-2.989s2.989 1.346 2.989 2.989-1.346 2.989-2.989 2.989c-1.677 0-3.033-1.346-3.033-2.989z"/>
    </svg>
  ),
  'dell-emc': ({ className, size = 24 }) => (
    <Icon name="database" size={size} className={className} />
  ),
  'netapp': ({ className, size = 24 }) => (
    <Icon name="hard-drive" size={size} className={className} />
  ),
  'nutanix': ({ className, size = 24 }) => (
    <Icon name="stack" size={size} className={className} />
  ),
  'openshift': ({ className, size = 24 }) => (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M21.665 13.085l-3.029-1.387c.205-.559.312-1.157.312-1.779 0-.62-.107-1.217-.311-1.775l3.028-1.388a9.963 9.963 0 0 1 0 6.329zM12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 18c-4.411 0-8-3.589-8-8s3.589-8 8-8 8 3.589 8 8-3.589 8-8 8z"/>
    </svg>
  ),
  'rancher': ({ className, size = 24 }) => (
    <Icon name="shipping-container" size={size} className={className} />
  ),

  // Monitoring / Observability
  'datadog': ({ className, size = 24 }) => (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.5 8.5l1.6-1.6c.2-.2.2-.5 0-.7-.2-.2-.5-.2-.7 0L13 7.9l-1.4-1.7c-.2-.2-.5-.2-.7 0s-.2.5 0 .7l1.6 1.6-1.6 1.6c-.2.2-.2.5 0 .7.1.1.2.1.4.1.1 0 .3 0 .4-.1l1.4-1.7 1.4 1.7c.1.1.2.1.4.1.1 0 .3 0 .4-.1.2-.2.2-.5 0-.7L13.5 8.5z"/>
    </svg>
  ),
  'dynatrace': ({ className, size = 24 }) => (
    <Icon name="pulse" size={size} className={className} />
  ),
  'appdynamics': ({ className, size = 24 }) => (
    <Icon name="gauge" size={size} className={className} />
  ),
  'prometheus': ({ className, size = 24 }) => (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2L2 7v10c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-10-5zm0 18c-3.31 0-6-2.69-6-6V8.5l6-3 6 3V14c0 3.31-2.69 6-6 6z"/>
    </svg>
  ),
  'lansweeper': ({ className, size = 24 }) => (
    <Icon name="graph" size={size} className={className} />
  ),
  'zabbix': ({ className, size = 24 }) => (
    <Icon name="pulse" size={size} className={className} />
  ),
  'cisco-meraki': ({ className, size = 24 }) => (
    <Icon name="graph" size={size} className={className} />
  ),
  'infoblox': ({ className, size = 24 }) => (
    <Icon name="graph" size={size} className={className} />
  ),
  'rubrik': ({ className, size = 24 }) => (
    <Icon name="database" size={size} className={className} />
  ),
  'veeam': ({ className, size = 24 }) => (
    <Icon name="hard-drive" size={size} className={className} />
  ),

  // Security
  'crowdstrike': ({ className, size = 24 }) => (
    <Icon name="shield" size={size} className={className} />
  ),
  'defender': ({ className, size = 24 }) => (
    <Icon name="shield" size={size} className={className} />
  ),
  'wiz': ({ className, size = 24 }) => (
    <Icon name="shield" size={size} className={className} />
  ),
  'tenable': ({ className, size = 24 }) => (
    <Icon name="shield" size={size} className={className} />
  ),
  'prisma-cloud': ({ className, size = 24 }) => (
    <Icon name="shield" size={size} className={className} />
  ),

  // Default/Fallback
  'default': ({ className, size = 24 }) => (
    <Icon name="cube" size={size} className={className} />
  ),
};

/**
 * Get icon component for a connector type
 * @param connectorType - The connector type (e.g., 'servicenow', 'jira')
 * @returns React component for the icon
 */
export function getConnectorIcon(connectorType: string): React.FC<ConnectorIconProps> {
  return ConnectorIcons[connectorType] || ConnectorIcons.default;
}

/**
 * Get category color for connector category
 */
export function getCategoryColor(category: string): string {
  switch (category?.toLowerCase()) {
    case 'cloud':
      return 'bg-purple-500';
    case 'virtualization':
      return 'bg-indigo-500';
    case 'container-orchestration':
      return 'bg-cyan-500';
    case 'monitoring':
      return 'bg-green-500';
    case 'security':
      return 'bg-red-500';
    case 'itsm':
      return 'bg-blue-500';
    case 'identity':
      return 'bg-amber-500';
    case 'endpoint-management':
      return 'bg-orange-500';
    case 'network':
      return 'bg-teal-500';
    case 'storage':
      return 'bg-slate-500';
    case 'backup':
      return 'bg-emerald-500';
    case 'asset-management':
      return 'bg-sky-500';
    case 'ticketing':
      return 'bg-violet-500';
    default:
      return 'bg-gray-500';
  }
}

/**
 * Get category label for connector category
 */
export function getCategoryLabel(category: string): string {
  switch (category?.toLowerCase()) {
    case 'cloud':
      return 'Cloud';
    case 'virtualization':
      return 'Virtualization';
    case 'container-orchestration':
      return 'Container Orchestration';
    case 'monitoring':
      return 'Monitoring';
    case 'security':
      return 'Security';
    case 'itsm':
      return 'ITSM';
    case 'identity':
      return 'Identity';
    case 'endpoint-management':
      return 'Endpoint Management';
    case 'network':
      return 'Network';
    case 'storage':
      return 'Storage';
    case 'backup':
      return 'Backup';
    case 'asset-management':
      return 'Asset Management';
    case 'ticketing':
      return 'Ticketing';
    default:
      return 'Custom';
  }
}
