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
  | 'update'
  | SourceOwnedCIType;

/**
 * HAP-1442 (AAI S1): AI CI classes. They are source-owned: only the AI sync writer (`AISyncWriter`, journaled, actor
 * `sync:<stream>`) creates or changes them; every other write path refuses them with `SourceOwnedError`.
 */
export const SOURCE_OWNED_CI_TYPES = ['agent-release', 'ai-model', 'cell', 'ai-deployment'] as const;
export type SourceOwnedCIType = typeof SOURCE_OWNED_CI_TYPES[number];

/** True for an AI class name in any spelling the write paths accept: `agent-release`, `agent_release`, `AGENT_RELEASE`. */
export function isSourceOwnedCIType(value: unknown): value is string {
  return typeof value === 'string'
    && (SOURCE_OWNED_CI_TYPES as readonly string[]).includes(value.trim().toLowerCase().replace(/_/g, '-'));
}

/** The system of record an AI CI's fields come from (design brief §4). */
export type AuthoritativeSource = 'happylab-c4' | 'hivecell-c8' | 'happycmdb-derived';
export type AILifecycle = 'live' | 'retired';

/** A write to a source-owned CI from anything but its sync writer; REST 409 / GraphQL `source_owned`. */
export class SourceOwnedError extends Error {
  readonly code = 'source_owned';
  constructor() {
    super('This CI class is owned by its source and changes only through its sync');
    this.name = 'SourceOwnedError';
  }
}

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
 * Relationship Type - Categories of relationships between CIs. The same values as VALID_RELATIONSHIP_TYPES
 * (security/cypher-validators), which a unit test compares.
 */
export const RELATIONSHIP_TYPES = [
  'DEPENDS_ON',    // Dependency relationship
  'HOSTS',         // Hosting relationship (e.g., server hosts application)
  'CONNECTS_TO',   // Network connection
  'USES',          // Usage relationship
  'OWNED_BY',      // Ownership
  'PART_OF',       // Component relationship
  'LOCATED_IN',    // Physical/logical location relationship
  'DEPLOYED_ON',   // Deployment relationship
  'BACKED_UP_BY',  // Backup relationship
  'DETECTED_ON',   // Alert/threat detected on device
  'AFFECTS',       // Vulnerability affects device
  'INSTALLED_ON',  // Software installed on device
  'CONTAINS',      // Incident contains detections
  'ASSIGNED_TO',   // Assignment relationship (e.g., device assigned to user)
  'APPLIES_TO',    // Application relationship (e.g., policy applies to device)
  'MEMBER_OF',     // Membership relationship (e.g., device member of collection)
  'REQUIRED_BY',   // Requirement relationship (e.g., update required by device)
  'HOSTED_ON',     // Storage/file hosted on server/system
  'MANAGES',       // Management relationship
  'MONITORS',      // Monitoring relationship
  'RUNS_ON',       // Workload runs on host
  'ROUTES_TO',     // Network routing
  'INSTANCE_OF',   // AI deployment is an instance of an agent release (HAP-1442)
] as const;
export type RelationshipType = typeof RELATIONSHIP_TYPES[number];
