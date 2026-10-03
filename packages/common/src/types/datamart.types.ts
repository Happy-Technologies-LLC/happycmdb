// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Data Mart Type Definitions
 *
 * This module contains all TypeScript types and interfaces for the PostgreSQL
 * data mart, including dimension and fact table input types.
 */

import { CIType, CIStatus, Environment, RelationshipType } from './ci.types';
import { DiscoveryProvider, DiscoveryMethod } from './discovery.types';

// ============================================
// DIMENSION TABLE INPUT TYPES
// ============================================

/**
 * CI Dimension Input
 * Used for inserting/updating CI dimension records with SCD Type 2 support
 */
export interface CIDimensionInput {
  /** UUID of the CI from Neo4j */
  ci_id: string;
  /** Name of the CI */
  ciname: string;
  /** Type of CI */
  ci_type: CIType;
  /** Current status of the CI */
  ci_status: CIStatus;
  /** Environment (optional) */
  environment?: Environment;
  /** External ID from source system (optional) */
  external_id?: string;
  /** Additional metadata (optional) */
  metadata?: Record<string, any>;
  /** Effective from timestamp (defaults to current time if not provided) */
  effective_from?: Date;
  /**
   * Owning organization (cmdb.dim_ci.organization_id, migration 011): the
   * :CI node's organization, or the internal organization
   * 00000000-0000-0000-0000-000000000000 for a CI that has none (FD-4).
   */
  organization_id: string;
}

/**
 * Location Dimension Input
 * Used for inserting location dimension records
 */
export interface LocationDimensionInput {
  /** Unique identifier for the location */
  location_id: string;
  /** Human-readable name */
  locationname: string;
  /** Type of location */
  location_type: 'cloud_region' | 'datacenter' | 'availability_zone' | 'subnet' | 'unknown';
  /** Cloud provider (if applicable) */
  cloud_provider?: 'aws' | 'azure' | 'gcp';
  /** Region identifier */
  region?: string;
  /** Country */
  country?: string;
  /** City */
  city?: string;
  /** Latitude coordinate */
  latitude?: number;
  /** Longitude coordinate */
  longitude?: number;
  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Owner Dimension Input
 * Used for inserting owner dimension records
 */
export interface OwnerDimensionInput {
  /** Unique identifier for the owner */
  owner_id: string;
  /** Human-readable name */
  ownername: string;
  /** Type of owner */
  owner_type: 'user' | 'team' | 'department' | 'cost_center' | 'system';
  /** Email address (optional) */
  email?: string;
  /** Department name (optional) */
  department?: string;
  /** Cost center code (optional) */
  cost_center?: string;
  /** Manager's owner_id (optional) */
  manager_id?: string;
  /** Additional metadata */
  metadata?: Record<string, any>;
}

// ============================================
// FACT TABLE INPUT TYPES
// ============================================

/**
 * Discovery Fact Input
 * Used for recording discovery events
 */
export interface DiscoveryFactInput {
  /** Foreign key to dim_ci */
  ci_key: number;
  /** Foreign key to dim_location (optional) */
  location_key?: number;
  /** Foreign key to dim_time */
  date_key: number;
  /** Timestamp when CI was discovered */
  discovered_at: Date;
  /** ID of the discovery job */
  discovery_job_id: string;
  /** Provider that discovered the CI */
  discovery_provider: DiscoveryProvider;
  /** Discovery method used */
  discoverymethod: DiscoveryMethod;
  /** Confidence score (0.0 to 1.0) */
  confidence_score?: number;
  /** Duration of discovery operation in milliseconds */
  discovery_duration_ms?: number;
}

/**
 * CI Changes Fact Input
 * Used for recording change events
 */
export interface ChangesFactInput {
  /** Foreign key to dim_ci */
  ci_key: number;
  /** Foreign key to dim_time */
  date_key: number;
  /** Timestamp when change occurred */
  changed_at: Date;
  /** Type of change */
  change_type: 'created' | 'updated' | 'deleted' | 'status_changed' | 'discovered' | 'modified';
  /** Name of the field that changed (optional) */
  field_name?: string;
  /** Previous value (optional) */
  old_value?: string;
  /** New value (optional) */
  new_value?: string;
  /** User/system that made the change (optional) */
  changed_by?: string;
  /** Source of the change */
  change_source?: 'discovery' | 'manual' | 'api' | 'import' | 'automation';
  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * CI Relationship Fact Input
 * Used for recording relationships between CIs
 */
export interface RelationshipFactInput {
  /** Foreign key to dim_ci (source) */
  from_ci_key: number;
  /** Foreign key to dim_ci (target) */
  to_ci_key: number;
  /** Foreign key to dim_time */
  date_key: number;
  /** Type of relationship */
  relationship_type: RelationshipType;
  /** Strength/importance of relationship (0.0 to 1.0) */
  relationship_strength?: number;
  /** Timestamp when relationship was discovered */
  discovered_at: Date;
  /** Timestamp when relationship was last verified (optional) */
  last_verified_at?: Date;
  /** Whether relationship is currently active */
  is_active?: boolean;
  /** Additional relationship properties */
  properties?: Record<string, any>;
}

// ============================================
// VIEW OUTPUT TYPES
// ============================================

/**
 * Current CI Inventory View Row
 */
export interface CurrentCIInventoryRow {
  ci_key: number;
  ci_id: string;
  ciname: string;
  ci_type: CIType;
  ci_status: CIStatus;
  environment?: Environment;
  external_id?: string;
  metadata?: Record<string, any>;
  effective_from: Date;
  created_at: Date;
  updated_at: Date;
}

/**
 * CI Discovery Summary View Row
 */
export interface CIDiscoverySummaryRow {
  ci_id: string;
  ciname: string;
  ci_type: CIType;
  discovery_provider: DiscoveryProvider;
  discovery_count: number;
  last_discovered_at: Date;
  avg_confidence_score: number;
  avg_discovery_duration_ms?: number;
}

/**
 * CI Change History View Row
 */
export interface CIChangeHistoryRow {
  change_key: number;
  ci_id: string;
  ciname: string;
  ci_type: CIType;
  change_type: string;
  field_name?: string;
  old_value?: string;
  new_value?: string;
  changed_at: Date;
  changed_by?: string;
  change_source?: string;
  full_date: Date;
  year: number;
  month: number;
  quarter: number;
}

/**
 * CI Relationship View Row
 */
export interface CIRelationshipRow {
  relationship_key: number;
  from_ci_id: string;
  from_ciname: string;
  from_ci_type: CIType;
  relationship_type: RelationshipType;
  to_ci_id: string;
  to_ciname: string;
  to_ci_type: CIType;
  relationship_strength?: number;
  discovered_at: Date;
  last_verified_at?: Date;
  properties?: Record<string, any>;
}

// ============================================
// UTILITY TYPES
// ============================================

/**
 * Time Dimension Row
 */
export interface TimeDimensionRow {
  date_key: number;
  full_date: Date;
  year: number;
  quarter: number;
  month: number;
  monthname: string;
  week: number;
  day_of_month: number;
  day_of_week: number;
  dayname: string;
  is_weekend: boolean;
  is_holiday: boolean;
  fiscal_year: number;
  fiscal_quarter: number;
}
