// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { useAuth } from '@contexts/AuthContext';
import { roleHasPermission, type Permission } from '@/lib/permissions';

/** Whether the signed-in user's server role holds `permission` (see lib/permissions.ts). */
export function usePermission(permission: Permission): boolean {
  const { user } = useAuth();
  return roleHasPermission(user?.role, permission);
}
