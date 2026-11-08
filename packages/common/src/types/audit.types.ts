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

// USER (HAP-1368): self-service password change attempts; migration 049 adds the database value.
export type AuditEntityType = 'CI' | 'RELATIONSHIP' | 'BUSINESS_SERVICE' | 'SERVICE_OFFERING' | 'USER';

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
