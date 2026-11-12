// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from 'react';
import { usePermission } from '@/hooks/usePermission';
import type { Permission } from '@/lib/permissions';

/**
 * Renders `children` only when the user's server role holds `permission`; otherwise `fallback` (default: nothing).
 * Wrap each write control in the permission the server route behind it enforces:
 * `write` for create, update and delete, `admin` for the admin-only routes.
 */
export function RequirePermission({
  permission,
  fallback = null,
  children,
}: {
  permission: Permission;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  return <>{usePermission(permission) ? children : fallback}</>;
}
