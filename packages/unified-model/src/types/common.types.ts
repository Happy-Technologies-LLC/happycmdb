// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Common types used across HappyCMDB v3.0 unified model
 */

/**
 * CI Type (from v2.0 compatibility)
 */
export type CIType =
  | 'server'
  | 'virtual-machine'
  | 'container'
  | 'application'
  | 'service'
  | 'database'
  | 'network-device'
  | 'storage'
  | 'load-balancer'
  | 'cloud-resource'
  | 'software'
  | 'facility'
  | 'documentation';

/**
 * CI Status
 */
export type CIStatus =
  | 'active'
  | 'inactive'
  | 'maintenance'
  | 'decommissioned';

/**
 * Environment
 */
export type Environment =
  | 'production'
  | 'staging'
  | 'development'
  | 'test'
  | 'disaster-recovery';

/**
 * Location information
 */
export interface Location {
  datacenter?: string;
  region?: string;
  availability_zone?: string;
  rack?: string;
  physical_address?: string;
  coordinates?: {
    latitude: number;
    longitude: number;
  };
}

/**
 * Audit trail fields
 */
export interface AuditFields {
  created_at: Date;
  updated_at: Date;
  created_by: string;
  updated_by: string;
}

/**
 * Discovery metadata
 */
export interface DiscoveryMetadata {
  discovered_by: string[];
  discovery_confidence: number; // 0-100
  last_discovered: Date;
}
