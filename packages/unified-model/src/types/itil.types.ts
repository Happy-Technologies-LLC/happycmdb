// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * ITIL v4 Service Management types
 */

/**
 * ITIL CI Class
 * Classification of configuration items according to ITIL best practices
 */
export type ITILCIClass =
  | 'hardware'
  | 'software'
  | 'service'
  | 'network'
  | 'facility'
  | 'documentation'
  | 'personnel';

/**
 * ITIL Lifecycle Stage
 * Represents the stage in the service lifecycle
 */
export type ITILLifecycle =
  | 'planning'
  | 'design'
  | 'build'
  | 'test'
  | 'deploy'
  | 'operate'
  | 'retire';

/**
 * ITIL Configuration Status
 * Current status of the configuration item
 */
export type ITILConfigStatus =
  | 'planned'
  | 'ordered'
  | 'in_development'
  | 'active'
  | 'maintenance'
  | 'retired'
  | 'disposed';

/**
 * Audit Status
 */
export type AuditStatus =
  | 'compliant'
  | 'non_compliant'
  | 'unknown';

/**
 * ITIL attributes for Configuration Items
 */
export interface ITILAttributes {
  ci_class: ITILCIClass;
  lifecycle_stage: ITILLifecycle;
  configuration_status: ITILConfigStatus;
  version: string;
  baseline_id?: string;
  last_audited: Date;
  audit_status: AuditStatus;
}

/**
 * Service Hours
 */
export interface ServiceHours {
  availability: '24x7' | '24x5' | 'business_hours' | 'custom';
  business_hours_start?: string;
  business_hours_end?: string;
  timezone: string;
  maintenance_windows: MaintenanceWindow[];
}

/**
 * Maintenance Window
 */
export interface MaintenanceWindow {
  day_of_week: number; // 0-6
  start_time: string; // HH:mm format
  end_time: string; // HH:mm format
  frequency: 'weekly' | 'monthly';
}

/**
 * SLA Targets
 */
export interface SLATargets {
  availability_percentage: number;
  response_time_ms: number;
  error_rate_percentage: number;
  measured_period: 'monthly' | 'quarterly' | 'annually';
}

/**
 * Support Level
 */
export type SupportLevel = 'l1' | 'l2' | 'l3' | 'l4';

/**
 * Service Type
 */
export type ServiceType =
  | 'business_service'
  | 'technical_service'
  | 'supporting_service';

/**
 * ITIL Service attributes
 */
export interface ITILServiceAttributes {
  service_owner: string;
  service_type: ServiceType;
  lifecycle_stage: ITILLifecycle;
  release_version: string;
  change_schedule: string;
}

/**
 * ITIL Business Service attributes
 */
export interface ITILBusinessServiceAttributes {
  service_owner: string;
  service_type: 'customer_facing' | 'internal' | 'infrastructure';
  service_hours: ServiceHours;
  sla_targets: SLATargets;
  support_level: SupportLevel;
  incident_count_30d: number;
  change_count_30d: number;
  availability_30d: number;
  /** Last service-level audit performed, if one has been tracked (not currently persisted by seed/default data) */
  last_audit_date?: Date | null;
  /** Outcome of the most recent service-level audit, if tracked */
  audit_status?: AuditStatus;
}
