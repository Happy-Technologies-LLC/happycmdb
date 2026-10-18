// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Discovery Job Type Definitions
 *
 * This module contains all TypeScript types and interfaces for discovery operations
 * in the CMDB platform. Discovery is the process of identifying and cataloging
 * configuration items from various sources.
 */

import { CIInput } from './ci.types';
import type { SafeDiscoveryScanConfig } from '../utils/discovery-scan-config';

/**
 * Discovery Job - Represents a discovery operation
 */
export interface DiscoveryJob {
  /** Unique identifier for the discovery job */
  id: string;
  /** Verified tenant of the queued discovery. */
  organizationId?: string;
  /** Provider/platform being discovered */
  provider: DiscoveryProvider;
  /** Discovery method used */
  method: DiscoveryMethod;
  /** Configuration for the discovery job */
  config: DiscoveryConfig;
  /** Current status of the job */
  status: JobStatus;
  /** Timestamp when job was created */
  created_at: string;
  /** Timestamp when job started execution */
  started_at?: string;
  /** Timestamp when job completed */
  completed_at?: string;
  /** Error message if job failed */
  error?: string;
}

/**
 * Discovery Provider - Network-based discovery protocols
 *
 * IMPORTANT: Discovery is for network-based discovery of UNKNOWN infrastructure.
 * For API-based import from KNOWN systems (AWS, Azure, GCP, Kubernetes, VMware, etc.),
 * use the Connector system instead.
 *
 * Discovery = Network scanning to find unknown devices and systems
 * Connectors = API integration with known platforms to import existing inventories
 */
export type DiscoveryProvider =
  | 'nmap'                // Network mapping and port scanning
  | 'ssh'                 // SSH-based deep discovery (credentials required)
  | 'active-directory'    // Active Directory domain discovery
  | 'snmp';               // SNMP device discovery (network devices, printers, etc.)

/**
 * Discovery Method - Approach used for discovery
 */
export type DiscoveryMethod =
  | 'agentless'  // Agentless discovery (API/network-based)
  | 'agent';     // Agent-based discovery

/**
 * Job Status - Status of a discovery job
 */
export type JobStatus =
  | 'pending'    // Job queued but not started
  | 'running'    // Job currently executing
  | 'completed'  // Job finished successfully
  | 'failed';    // Job failed with error

/**
 * Discovery Config - Configuration for a discovery job
 */
export interface DiscoveryConfig {
  /** Authentication credentials for the provider */
  credentials?: any;
  /** Regions to discover (for cloud providers) */
  regions?: string[];
  /** Filters to apply during discovery */
  filters?: Record<string, any>;
  /** Target hosts/resources to discover */
  targets?: string[];
}

/**
 * Discovered CI - Configuration Item discovered from a source
 * Extends CIInput with discovery-specific metadata
 */
export interface DiscoveredCI extends CIInput {
  /** ID of the discovery job that found this CI */
  discovery_job_id: string;
  /** Provider that discovered this CI */
  discovery_provider: DiscoveryProvider;
  /** Confidence score for the discovery (0-1) */
  confidence_score: number;
}

/**
 * Discovery Definition - Reusable discovery configuration
 * Combines credentials, provider settings, and schedule into a named definition
 */
export interface DiscoveryDefinition {
  /** Unique identifier for the definition */
  id: string;
  /** Human-readable name for the definition */
  name: string;
  /** Optional description */
  description?: string;
  /** Discovery provider/platform */
  provider: DiscoveryProvider;
  /** Discovery method */
  method: DiscoveryMethod;
  /** Reference to stored credentials (from credentials table) - NULL for nmap */
  credential_id?: string;
  /** Agent ID for agent-based discovery - NULL for agentless */
  agent_id?: string;
  /** Nonsecret targets/range and scan-mode switches; credentials use credential_id. */
  config: SafeDiscoveryScanConfig;
  /** Field mappings from source fields to target CI fields (standard or metadata) */
  field_mappings?: Record<string, string>;
  /** Cron expression for scheduled execution (optional) */
  schedule?: string;
  /** Whether this definition is active */
  is_active: boolean;
  /** Tags for organization and filtering */
  tags?: string[];
  /** User who created the definition */
  created_by: string;
  /** Timestamp when definition was created */
  created_at: string;
  /** Timestamp when definition was last updated */
  updated_at: string;
  /** Timestamp of last successful run */
  last_run_at?: string;
  /** Status of last run */
  last_run_status?: JobStatus;
  /** ID of last discovery job */
  last_job_id?: string;
}

/**
 * Discovery Definition Input - Data for creating/updating a definition
 */
export interface DiscoveryDefinitionInput {
  /** Human-readable name for the definition */
  name: string;
  /** Optional description */
  description?: string;
  /** Discovery provider/platform */
  provider: DiscoveryProvider;
  /** Discovery method */
  method: DiscoveryMethod;
  /** Reference to stored credentials (optional - not needed for nmap) */
  credential_id?: string;
  /** Agent ID for agent-based discovery (optional - only for method='agent') */
  agent_id?: string;
  /** Nonsecret scan settings only. */
  config: SafeDiscoveryScanConfig;
  /** Field mappings from source fields to target CI fields (standard or metadata) */
  field_mappings?: Record<string, string>;
  /** Cron expression for scheduled execution (optional) */
  schedule?: string;
  /** Whether this definition is active */
  is_active?: boolean;
  /** Tags for organization and filtering */
  tags?: string[];
}

/**
 * Discovery Agent - Represents a registered discovery agent
 */
export interface DiscoveryAgent {
  /** Unique identifier */
  id: string;
  /** Agent identifier (hostname-macaddr) */
  agent_id: string;
  /** Hostname of the agent */
  hostname: string;
  /** Discovery providers this agent supports */
  provider_capabilities: DiscoveryProvider[];
  /** Networks this agent can reach (CIDR notation) */
  reachable_networks: string[];
  /** Agent version */
  version?: string;
  /** Platform (linux, darwin, win32) */
  platform?: string;
  /** Architecture (x64, arm64) */
  arch?: string;
  /** Endpoint for reverse communication */
  api_endpoint?: string;
  /** Agent status */
  status: AgentStatus;
  /** Last heartbeat timestamp */
  last_heartbeat_at: string;
  /** Last job timestamp */
  last_job_at?: string;
  /** Total jobs completed */
  total_jobs_completed: number;
  /** Total jobs failed */
  total_jobs_failed: number;
  /** Total CIs discovered */
  total_cis_discovered: number;
  /** Tags for organization */
  tags?: string[];
  /** Registration timestamp */
  registered_at: string;
  /** Last update timestamp */
  updated_at: string;
}

/**
 * Agent Status
 */
export type AgentStatus = 'active' | 'inactive' | 'offline' | 'disabled';

/**
 * Discovery Agent Registration Input
 */
export interface DiscoveryAgentRegistration {
  /** Omit on initial registration; supply the issued ID to retry/update within the same organization. */
  agent_id?: string;
  /** Hostname of the agent */
  hostname: string;
  /** Discovery providers this agent supports */
  provider_capabilities: DiscoveryProvider[];
  /** Networks this agent can reach (CIDR notation) */
  reachable_networks: string[];
  /** Agent version */
  version?: string;
  /** Platform (linux, darwin, win32) */
  platform?: string;
  /** Architecture (x64, arm64) */
  arch?: string;
  /** Endpoint for reverse communication */
  api_endpoint?: string;
  /** Tags for organization */
  tags?: string[];
}

/**
 * Agent Heartbeat
 */
export interface AgentHeartbeat {
  /** Agent identifier */
  agent_id: string;
  /** Current status */
  status: AgentStatus;
  /** Optional statistics update */
  stats?: {
    jobs_completed?: number;
    jobs_failed?: number;
    cis_discovered?: number;
  };
}
