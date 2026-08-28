// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// CI Types
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
  | 'cloud-resource';

export type CIStatus = 'active' | 'inactive' | 'maintenance' | 'decommissioned';

export type Environment = 'production' | 'staging' | 'development' | 'test';

// Configuration Item
export interface ConfigurationItem {
  ci_id: string;
  name: string;
  type: CIType;
  status: CIStatus;
  environment?: Environment;
  description?: string;
  ip_address?: string;
  hostname?: string;
  os?: string;
  version?: string;
  location?: string;
  cost_center?: string;
  owner?: string;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
  discovered_at: string;
  last_seen: string;
  confidence_score: number;
  created_at: string;
  updated_at: string;
}

// CI Relationship
export interface CIRelationship {
  relationship_id: string;
  from_ci_id: string;
  to_ci_id: string;
  relationship_type: string;
  properties?: Record<string, unknown>;
  created_at: string;
}

// Discovery Job
export interface DiscoveryJob {
  job_id: string;
  provider: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  started_at?: string;
  completed_at?: string;
  cis_discovered?: number;
  error_message?: string;
}

// Discovery Schedule
export interface DiscoverySchedule {
  schedule_id: string;
  name: string;
  provider: string;
  cron_expression: string;
  enabled: boolean;
  last_run?: string;
  next_run?: string;
  created_at: string;
  updated_at: string;
}

// User
export interface User {
  user_id: string;
  username: string;
  email: string;
  full_name: string;
  avatar?: string;
  role: 'admin' | 'user' | 'viewer';
  created_at: string;
  last_login?: string;
}

// Authentication
export interface AuthToken {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

// API Response types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

// Filter and Search
export interface FilterOptions {
  type?: CIType[];
  status?: CIStatus[];
  environment?: Environment[];
  search?: string;
}

export interface SortOptions {
  field: string;
  order: 'asc' | 'desc';
}

export interface PaginationOptions {
  page: number;
  limit: number;
}

// Graph Visualization
export interface GraphNode {
  id: string;
  label: string;
  type: CIType;
  status: CIStatus;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  type: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Dashboard Statistics
export interface DashboardStats {
  total_cis: number;
  cis_by_type: Record<CIType, number>;
  cis_by_status: Record<CIStatus, number>;
  cis_by_environment: Record<Environment, number>;
  recent_discoveries: number;
  health_score: number;
}

// Data Table
export interface DataTableColumn<T = unknown> {
  field: keyof T | string;
  headerName: string;
  width?: number;
  flex?: number;
  sortable?: boolean;
  filterable?: boolean;
  renderCell?: (value: unknown, row: T) => React.ReactNode;
}

// Form types
export interface FormField {
  name: string;
  label: string;
  type: 'text' | 'select' | 'multiselect' | 'date' | 'textarea' | 'number';
  required?: boolean;
  options?: { value: string; label: string }[];
  validation?: Record<string, unknown>;
  defaultValue?: unknown;
}

// Notification
export interface Notification {
  id: string;
  type: 'success' | 'error' | 'warning' | 'info';
  message: string;
  timestamp: string;
}

// Error types
export interface ApiError {
  message: string;
  code?: string;
  status?: number;
  details?: Record<string, unknown>;
}

// ============================================================================
// PHASE 2: Integration Framework Types
// ============================================================================

export interface Connector {
  id: string;
  name: string;
  type: 'servicenow' | 'jira' | 'aws' | 'azure' | 'gcp' | 'custom' | 'bmc_remedy' | 'datadog' | 'splunk';
  status: 'active' | 'inactive' | 'error';
  description?: string;
  config: Record<string, any>;
  schedule_enabled?: boolean;
  last_run_at?: string;
  last_run_status?: 'success' | 'failed' | 'partial';
  next_run_at?: string;
  created_at: string;
  updated_at: string;
}

export interface ConnectorRun {
  id: string;
  connector_name: string;
  connector_type: string;
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
  records_extracted: number;
  records_transformed: number;
  records_loaded: number;
  errors?: any[];
}

export interface TransformationRule {
  id: string;
  name: string;
  description?: string;
  source_system: string;
  target_ci_type: string;
  field_mappings: FieldMapping[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface FieldMapping {
  source_field: string;
  target_field: string;
  transformation_type: 'direct' | 'script' | 'lookup' | 'constant';
  transformation_config?: {
    script?: string;
    lookup_table?: string;
    constant_value?: any;
    default_value?: any;
  };
  is_required: boolean;
}

// ============================================================================
// PHASE 4: AI/ML Engine Types
// ============================================================================

export interface Anomaly {
  id: string;
  ci_id: string;
  ci_name: string;
  anomaly_type: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  confidence_score: number;
  detected_at: string;
  description: string;
  metrics: Record<string, any>;
  context: Record<string, any>;
  status: 'detected' | 'investigating' | 'resolved' | 'false_positive';
  resolved_at?: string;
  resolved_by?: string;
}

export interface ImpactAnalysis {
  id: string;
  source_ci_id: string;
  source_ci_name: string;
  change_type: string;
  impact_score: number;
  blast_radius: number;
  critical_path: string[];
  risk_level: 'minimal' | 'low' | 'medium' | 'high' | 'critical';
  analyzed_at: string;
  estimated_downtime_minutes?: number;
  affected_cis: AffectedCI[];
}

export interface AffectedCI {
  ci_id: string;
  ci_name: string;
  ci_type: string;
  impact_type: 'direct' | 'indirect';
  dependency_path: string[];
  hop_count: number;
  impact_probability: number;
  estimated_impact: string;
}

export interface DriftDetectionResult {
  ci_id: string;
  ci_name: string;
  has_drift: boolean;
  drift_score: number;
  drifted_fields: DriftedField[];
  baseline_snapshot_id: string;
  detected_at: string;
}

export interface DriftedField {
  field_name: string;
  baseline_value: any;
  current_value: any;
  change_type: 'added' | 'removed' | 'modified';
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
}

export interface BaselineSnapshot {
  id: string;
  ci_id: string;
  snapshot_type: 'configuration' | 'performance' | 'relationships';
  snapshot_data: Record<string, any>;
  created_at: string;
  created_by: string;
  is_approved: boolean;
  approved_by?: string;
  approved_at?: string;
}

export interface DependencyGraph {
  nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
  metadata: {
    total_nodes: number;
    total_edges: number;
    max_depth: number;
    generated_at: string;
  };
}

export interface DependencyGraphNode {
  id: string;
  ci_id: string;
  ci_name: string;
  ci_type: string;
  criticality: number;
  dependencies_count: number;
  dependents_count: number;
}

export interface DependencyGraphEdge {
  source_id: string;
  target_id: string;
  relationship_type: string;
  weight: number;
  is_critical: boolean;
}

// ============================================================================
// Health & Metrics Types
// ============================================================================

export interface MetricsSummary {
  total_cis: number;
  total_relationships: number;
  active_connectors: number;
  recent_anomalies: number;
  high_risk_changes: number;
  drift_detected: number;
  connector_success_rate: number;
  last_updated: string;
}

export interface HealthStatus {
  service: string;
  status: 'healthy' | 'degraded' | 'down';
  last_check: string;
  response_time_ms?: number;
  error?: string;
}
