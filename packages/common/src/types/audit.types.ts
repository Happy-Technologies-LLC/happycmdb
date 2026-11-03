// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit Log Type Definitions
 *
 * Tracks all changes to CIs and relationships for compliance and troubleshooting
 */

export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'RELATIONSHIP_ADD'
  | 'RELATIONSHIP_REMOVE'
  | 'DISCOVERY_UPDATE';

export type AuditEntityType = 'CI' | 'RELATIONSHIP' | 'BUSINESS_SERVICE';

export interface AuditLogEntry {
  id: string;
  entity_type: AuditEntityType;
  entity_id: string;
  action: AuditAction;
  actor: string; // user or system that made the change
  actor_type: 'user' | 'system' | 'discovery';
  changes: AuditChange[];
  metadata?: Record<string, any>;
  timestamp: string;
  ip_address?: string;
  user_agent?: string;
}

export interface AuditChange {
  field: string;
  old_value: any;
  new_value: any;
  field_type?: string; // To handle special rendering for certain types
}

export interface AuditLogQuery {
  entity_type?: AuditEntityType;
  entity_id?: string;
  action?: AuditAction;
  actor?: string;
  from_date?: string;
  to_date?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLogResponse {
  entries: AuditLogEntry[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}
