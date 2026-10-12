// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Configuration Item (CI) Type Definitions
 *
 * This module contains all TypeScript types and interfaces for Configuration Items (CIs)
 * in the CMDB platform. CIs represent any component that needs to be managed in order
 * to deliver an IT service.
 */

/**
 * Configuration Item - Core interface representing any managed component
 */
export interface CI {
  /** Unique identifier for the CI */
  _id: string;
  /** External identifier from source system (e.g., AWS instance ID) */
  external_id?: string;
  /** Human-readable name of the CI */
  name: string;
  /** Type/category of the CI */
  _type: CIType;
  /** Current operational status */
  _status: CIStatus;
  /** Deployment environment */
  environment?: Environment;
  /** Timestamp when CI was created in CMDB */
  _created_at: string;
  /** Graph-issued immutable incarnation for SQL-derived row provenance. */
  _incarnation_id?: string;
  /** Timestamp when CI was last updated */
  _updated_at: string;
  /** Timestamp when CI was discovered */
  _discovered_at: string;
  /** Additional metadata and attributes */
  _metadata: Record<string, any>;
}

/**
 * CI Type - Categorization of configuration items
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
  | 'alert'
  | 'vulnerability'
  | 'software'
  | 'detection'
  | 'incident'
  | 'hardware-component'
  | 'mobile-device'
  | 'policy'
  | 'configuration'
  | 'user'
  | 'group'
  | 'organizational-unit'
  | 'collection'
  | 'update';

/**
 * CI Status - Operational status of a configuration item
 */
export type CIStatus = 'active' | 'inactive' | 'maintenance' | 'decommissioned';

/**
 * Environment - Deployment environment classification
 */
export type Environment = 'production' | 'staging' | 'development' | 'test';

/**
 * CI Input - Data transfer object for creating/updating CIs
 */
export interface CIInput {
  /** Unique identifier for the CI */
  _id: string;
  /** External identifier from source system */
  external_id?: string;
  /** Human-readable name of the CI */
  name: string;
  /** Type/category of the CI */
  _type: CIType;
  /** Current operational status (defaults to 'active' if not provided) */
  status?: CIStatus;
  /** Deployment environment */
  environment?: Environment;
  /** Timestamp when CI was discovered */
  discovered_at?: string;
  /** Additional metadata and attributes */
  metadata?: Record<string, any>;
}

/**
 * Relationship - Represents a connection between two CIs
 */
export interface Relationship {
  /** Source CI identifier */
  _from_id: string;
  /** Target CI identifier */
  _to_id: string;
  /** Type of relationship */
  _type: RelationshipType;
  /** Additional relationship properties */
  properties?: Record<string, any>;
}

/**
 * Relationship Type - Categories of relationships between CIs
 */
export type RelationshipType =
  | 'DEPENDS_ON'    // Dependency relationship
  | 'HOSTS'         // Hosting relationship (e.g., server hosts application)
  | 'CONNECTS_TO'   // Network connection
  | 'USES'          // Usage relationship
  | 'OWNED_BY'      // Ownership
  | 'PART_OF'       // Component relationship
  | 'LOCATED_IN'    // Physical/logical location relationship
  | 'DEPLOYED_ON'   // Deployment relationship
  | 'BACKED_UP_BY'  // Backup relationship
  | 'DETECTED_ON'   // Alert/threat detected on device
  | 'AFFECTS'       // Vulnerability affects device
  | 'INSTALLED_ON'  // Software installed on device
  | 'CONTAINS'      // Incident contains detections
  | 'ASSIGNED_TO'   // Assignment relationship (e.g., device assigned to user)
  | 'APPLIES_TO'    // Application relationship (e.g., policy applies to device)
  | 'MEMBER_OF'     // Membership relationship (e.g., device member of collection)
  | 'REQUIRED_BY'   // Requirement relationship (e.g., update required by device)
  | 'HOSTED_ON';    // Storage/file hosted on server/system
