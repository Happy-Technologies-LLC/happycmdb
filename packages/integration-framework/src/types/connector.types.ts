// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration Connector Types (v3.0)
 * Types for external system integrations (ServiceNow, Jira, etc.)
 * Now supports multi-resource connectors with N8N-style resource management
 */

/**
 * Resource-level operation types
 */
export type ResourceOperation =
  | 'extract'           // Read data from external system
  | 'transform'         // Transform to CMDB format
  | 'load'              // Write to CMDB
  | 'sync_to_source'    // Write back to external system
  | 'test_connection';  // Test resource accessibility

/**
 * Connector Resource Definition
 */
export interface ConnectorResource {
  /** Unique resource identifier */
  id: string;

  /** Display name */
  name: string;

  /** Resource description */
  description: string;

  /** CI type this resource maps to */
  ci_type: string | null;

  /** Supported operations */
  operations: ResourceOperation[];

  /** Resource-specific configuration schema */
  configuration_schema?: Record<string, any>;

  /** Default enabled state */
  enabled_by_default: boolean;

  /** Extraction strategy */
  extraction?: {
    /** Supports incremental sync (delta) */
    incremental: boolean;

    /** Batch size for pagination */
    batch_size?: number;

    /** Rate limiting (requests per second) */
    rate_limit?: number;

    /** Dependencies on other resources */
    depends_on?: string[];
  };

  /** Field mappings from source to target fields */
  field_mappings?: Record<string, string>;
}

/**
 * Connector Metadata - from connector.json
 */
export interface ConnectorMetadata {
  type: string;
  name: string;
  version: string;
  description: string;
  author: string;
  verified: boolean;
  category: 'discovery' | 'connector';

  /** Available resources in this connector */
  resources: ConnectorResource[];

  /** Connector-level capabilities */
  capabilities: {
    extraction: boolean;
    relationships: boolean;
    incremental: boolean;
    bidirectional: boolean;
  };

  /** Global configuration schema (applies to all resources) */
  configuration_schema: Record<string, any>;
}

/**
 * Connector Configuration - instance configuration (v3.0)
 * Now supports multi-resource selection and per-resource configuration
 */
export interface ConnectorConfiguration {
  id?: string;
  name: string;
  type: string;
  /** Credential to resolve at run time; when set, auth is injected into `connection` from the encrypted credential store */
  credential_id?: string;
  enabled: boolean;
  schedule?: string;

  /** Global connection configuration (applies to all resources) */
  connection: Record<string, any>;

  /** Global options (applies to all resources) */
  options?: Record<string, any>;

  /** List of enabled resource IDs. If null/undefined, use resources with enabled_by_default=true */
  enabled_resources?: string[];

  /** Resource-specific configurations keyed by resource ID */
  resource_configs?: Record<string, Record<string, any>>;

  created_at?: Date;
  updated_at?: Date;
}

/**
 * Connection Test Result
 */
export interface TestResult {
  success: boolean;
  message?: string;
  details?: Record<string, any>;
}

/**
 * Extracted Data from external system
 */
export interface ExtractedData {
  external_id: string;
  data: Record<string, any>;
  source_type: string;
  extracted_at: Date;
}

/**
 * Extracted Relationship
 */
export interface ExtractedRelationship {
  source_external_id: string;
  target_external_id: string;
  relationship_type: string;
  properties?: Record<string, any>;
}

/**
 * Transformed CI ready for CMDB
 */
export interface TransformedCI {
  name: string;
  ci_type: string;
  environment?: string;
  status?: string;
  attributes: Record<string, any>;
  identifiers: IdentificationAttributes;
  source: string;
  source_id: string;
  confidence_score: number;
  relationships?: ExtractedRelationship[];
}

/**
 * Identification Attributes for reconciliation
 */
export interface IdentificationAttributes {
  external_id?: string;
  serial_number?: string;
  uuid?: string;
  mac_address?: string[];
  fqdn?: string;
  hostname?: string;
  ip_address?: string[];
  custom_identifiers?: Record<string, string>;
}

/**
 * Connector Run Result
 */
export interface ConnectorRunResult {
  run_id: string;
  connector_name: string;
  started_at: Date;
  completed_at?: Date;
  status: 'running' | 'completed' | 'failed';
  records_extracted: number;
  records_transformed: number;
  records_loaded: number;
  errors?: string[];
}

/**
 * Resource Run Result (per-resource metrics)
 */
export interface ResourceRunResult {
  run_id: string;
  config_id: string;
  connector_type: string;
  resource_id: string;
  started_at: Date;
  completed_at?: Date;
  status: 'running' | 'completed' | 'failed';
  records_extracted: number;
  records_transformed: number;
  records_loaded: number;
  errors?: any[];
  duration_ms?: number;
}

/**
 * Installed Connector Record
 */
export interface InstalledConnector {
  connector_type: string;
  version: string;
  installed_at: Date;
  metadata: ConnectorMetadata;
  install_path: string;
  checksum?: string;
}

/**
 * Connector Events
 */
export type ConnectorEvent =
  | 'initialized'
  | 'connection_tested'
  | 'extraction_started'
  | 'extraction_completed'
  | 'extraction_failed'
  | 'data_extracted'
  | 'transformation_started'
  | 'transformation_completed'
  | 'relationships_extracted'
  | 'ci_discovered';
