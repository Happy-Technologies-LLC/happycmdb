// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1252 S1 (N8 a): the web UI's mirror of the server's role contract.
 *
 * The server stays the authority: every route is checked by `requirePermission` / `requireRole`
 * (packages/api-server/src/middleware/auth.middleware.ts). This table only decides which write controls the UI
 * shows; a stale or wrong entry can hide a control, never grant access. It copies `UserRole`, `Permission` and
 * `ROLE_PERMISSIONS` from packages/api-server/src/auth/types.ts verbatim; GET /auth/me returns that same `role`.
 *
 * Facts the server decides from data the API does not expose (platform administrator, `_organizationId`, dedicated
 * scopes) are NOT modelled here. The UI never infers them: it shows the server's 403 reason instead
 * (lib/forbidden.ts).
 */

export type ServerRole = 'admin' | 'operator' | 'viewer' | 'agent';

export type Permission = 'read' | 'write' | 'discover' | 'admin';

export const ROLE_PERMISSIONS: Readonly<Record<ServerRole, readonly Permission[]>> = {
  admin: ['read', 'write', 'discover', 'admin'],
  operator: ['read', 'write', 'discover'],
  viewer: ['read'],
  agent: ['discover', 'write'],
};

export const isServerRole = (value: unknown): value is ServerRole =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, value);

/** True when `role` holds `permission`. An unknown or missing role holds nothing (fail closed in the UI only). */
export const roleHasPermission = (role: unknown, permission: Permission): boolean =>
  isServerRole(role) && ROLE_PERMISSIONS[role].includes(permission);
