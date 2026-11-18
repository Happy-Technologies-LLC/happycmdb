// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1930 (BW16): one 403 body for the role-contract refusals (permission, role, organization, JWT session,
 * platform administrator, scope), so a client renders every one of them the same way.
 *
 * The body carries BOTH historical key families, so no existing reader breaks: `{_error, _message}` (what the
 * auth middleware always sent) and `{success, error, message}` (what the platform-administrator gate and the
 * organization-claim guards sent). `code` is the stable machine-readable reason; `required` names what was missing;
 * `role` is the caller's own server role when the refusal is role-based, so the UI can say "viewer lacks 'write'"
 * without guessing. `role` and `required` carry the caller's own role and the route's fixed requirement, never
 * another user's data.
 */

import type { Response } from 'express';

import type { Permission } from '../auth/types';

export type ForbiddenCode =
  | 'PERMISSION_REQUIRED'
  | 'ROLE_REQUIRED'
  | 'ORGANIZATION_REQUIRED'
  | 'JWT_SESSION_REQUIRED'
  | 'PLATFORM_ADMIN_REQUIRED'
  | 'SCOPE_REQUIRED';

export interface ForbiddenRequirement {
  permission?: Permission;
  roles?: string[];
  scope?: string;
}

export interface ForbiddenBody {
  success: false;
  error: 'Forbidden';
  message: string;
  _error: 'Forbidden';
  _message: string;
  code: ForbiddenCode;
  required?: ForbiddenRequirement;
  role?: string;
}

export function forbiddenBody(
  code: ForbiddenCode,
  message: string,
  detail: { required?: ForbiddenRequirement; role?: string } = {}
): ForbiddenBody {
  const body: ForbiddenBody = {
    success: false,
    error: 'Forbidden',
    message,
    _error: 'Forbidden',
    _message: message,
    code,
  };
  if (detail.required !== undefined) {
    body.required = detail.required;
  }
  if (detail.role !== undefined) {
    body.role = detail.role;
  }
  return body;
}

export function sendForbidden(
  res: Response,
  code: ForbiddenCode,
  message: string,
  detail: { required?: ForbiddenRequirement; role?: string } = {}
): void {
  res.status(403).json(forbiddenBody(code, message, detail));
}
