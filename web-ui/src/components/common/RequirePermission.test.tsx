// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Permission } from '@/lib/permissions';
import { RequirePermission } from './RequirePermission';

const auth = vi.hoisted(() => ({ role: undefined as string | undefined }));
vi.mock('@contexts/AuthContext', () => ({
  useAuth: () => ({ user: auth.role ? { role: auth.role } : null }),
}));

const shown = (permission: Permission) => {
  render(
    <RequirePermission permission={permission} fallback={<span>denied</span>}>
      <button type="button">act</button>
    </RequirePermission>,
  );
  return screen.queryByRole('button', { name: 'act' }) !== null;
};

beforeEach(() => {
  auth.role = undefined;
});

// The rows mirror what the server enforces: ROLE_PERMISSIONS in packages/api-server/src/auth/types.ts.
describe('RequirePermission', () => {
  it.each<[string, Permission, boolean]>([
    ['viewer', 'read', true],
    ['viewer', 'write', false],
    ['viewer', 'admin', false],
    ['operator', 'write', true],
    ['operator', 'admin', false],
    ['admin', 'write', true],
    ['admin', 'admin', true],
    ['agent', 'write', true],
    ['agent', 'admin', false],
    ['agent', 'read', false],
  ])('%s with "%s" required: control shown = %s', (role, permission, expected) => {
    auth.role = role;
    expect(shown(permission)).toBe(expected);
    if (!expected) expect(screen.getByText('denied')).toBeInTheDocument();
  });

  it('hides everything from a role the server does not define, and from no user', () => {
    auth.role = 'superuser';
    expect(shown('read')).toBe(false);
  });

  it('hides everything when nobody is signed in', () => {
    expect(shown('write')).toBe(false);
  });
});
