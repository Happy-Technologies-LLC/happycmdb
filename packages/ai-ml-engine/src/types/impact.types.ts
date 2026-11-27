// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Impact Analysis Types
 */

export interface ImpactAnalysis {
  id: string;
  source_ci_id: string;
  source_ci_name: string;
  change_type: ChangeType;
  impact_score: number; // 0-100
  affected_cis: AffectedCI[];
  blast_radius: number; // Number of CIs affected
  critical_path: string[]; // CI IDs in critical dependency path
  risk_level: RiskLevel;
  analyzed_at: Date;
  estimated_downtime_minutes?: number;
}

export enum ChangeType {
  CONFIGURATION_CHANGE = 'configuration_change',
  VERSION_UPGRADE = 'version_upgrade',
  RESTART = 'restart',
  DECOMMISSION = 'decommission',
  NETWORK_CHANGE = 'network_change',
  SECURITY_CHANGE = 'security_change',
  PERFORMANCE_TUNING = 'performance_tuning',
  /** HAP-1927 (BW12): switch the CI's role to a standby. Weighted and given a downtime estimate by ImpactPredictionEngine. */
  FAILOVER = 'failover',
}

export enum RiskLevel {
  CRITICAL = 'critical',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
  MINIMAL = 'minimal',
}

export interface AffectedCI {
  ci_id: string;
  ci_name: string;
  ci_type: string;
  impact_type: ImpactType;
  dependency_path: string[]; // Path from source to this CI
  hop_count: number; // Distance from source
  impact_probability: number; // 0-100
  estimated_impact: string;
  /**
   * HAP-1927 (BW12): which side of the source CI this one is on. `downstream` = it depends on the source (affected when the
   * source changes or fails); `upstream` = the source depends on it. The prediction walks dependents only, so every record
   * it produces is `downstream`. Records persisted before this field omit it, so it is optional.
   */
  direction?: ImpactDirection;
}

export type ImpactDirection = 'upstream' | 'downstream';

export enum ImpactType {
  DIRECT = 'direct', // Direct dependency
  INDIRECT = 'indirect', // Transitive dependency
  CASCADING = 'cascading', // Multiple paths affected
  PERFORMANCE = 'performance', // Performance impact
  AVAILABILITY = 'availability', // Availability impact
}

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  metadata: {
    total_nodes: number;
    total_edges: number;
    max_depth: number;
    generated_at: Date;
  };
}

export interface GraphNode {
  id: string;
  ci_id: string;
  ci_name: string;
  ci_type: string;
  criticality: number; // 0-100
  dependencies_count: number;
  dependents_count: number;
}

export interface GraphEdge {
  source_id: string;
  target_id: string;
  relationship_type: string;
  weight: number; // Strength of dependency 0-1
  is_critical: boolean;
}

export interface CriticalityScore {
  ci_id: string;
  ci_name: string;
  criticality_score: number; // 0-100
  factors: CriticalityFactors;
  calculated_at: Date;
}

export interface CriticalityFactors {
  dependent_count: number; // How many CIs depend on this
  dependent_weight: number; // Sum of dependent criticalities
  change_frequency: number; // How often it changes
  failure_history: number; // Historical failure rate
  business_impact: number; // Business criticality (manual)
}

export interface ChangeImpactPrediction {
  change_id: string;
  source_ci_id: string;
  predicted_impact: ImpactAnalysis;
  recommendations: string[];
  approval_required: boolean;
  maintenance_window_suggested: boolean;
  rollback_plan?: string;
}
