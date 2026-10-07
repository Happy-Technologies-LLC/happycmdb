// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import type { Request, Response, NextFunction } from 'express';
import { organizationClaim } from '../middleware/auth.middleware';
import type { TokenPayload } from './types';

export interface ConnectorScope {
  organizationId: string | null;
  legacy: boolean;
}

export function connectorScope(user: TokenPayload | undefined): ConnectorScope {
  return { organizationId: organizationClaim(user), legacy: user?._platformAdmin === true };
}

export function requireConnectorScope(req: Request, res: Response, next: NextFunction): void {
  const scope = connectorScope((req as Request & { user?: TokenPayload }).user);
  if (scope.organizationId === null && !scope.legacy) {
    res.status(403).json({ error: 'Forbidden', message: 'Organization claim required' });
    return;
  }
  next();
}

/** Global connector uninstall cascades across tenant configurations. */
export function requireConnectorPlatformAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: TokenPayload }).user;
  if (user?._platformAdmin !== true) {
    res.status(403).json({ error: 'Forbidden', message: 'Platform authority required' });
    return;
  }
  next();
}

/** Tenants see only their organization. Platform authority adds only NULL legacy rows. */
export function connectorPredicate(alias: string, first: number): string {
  return `(${alias}.organization_id = $${first} OR (${alias}.organization_id IS NULL AND $${first + 1}::boolean))`;
}

export function scopeValues(user: TokenPayload | undefined): [string | null, boolean] {
  const scope = connectorScope(user);
  return [scope.organizationId, scope.legacy];
}

export const PUBLIC_CONFIG = `id, organization_id, name, description, connector_type, enabled,
  schedule, schedule_enabled, enabled_resources, max_retries, retry_delay_seconds,
  continue_on_error, notification_on_success, notification_on_failure,
  created_at, updated_at, created_by, updated_by`;
export const PUBLIC_RUN = `id, organization_id, config_id, connector_type, config_name,
  resource_id, started_at, completed_at, status, records_extracted,
  records_transformed, records_loaded, records_failed, duration_ms, triggered_by`;

export const CONFIG_NOT_FOUND = { success: false, error: 'Not Found', message: 'Configuration not found' };
export const RUN_NOT_FOUND = { success: false, error: 'Not Found', message: 'Run not found' };
