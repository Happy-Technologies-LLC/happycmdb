// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { credentialService } from '@/services/credential.service';
import { Credentials } from './Credentials';

const auth = vi.hoisted(() => ({ role: 'viewer' }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

const row = {
  id: 'c1', name: 'prod-ssh', protocol: 'ssh_key', scope: 'universal', tags: [], created_at: '2026-10-01T00:00:00Z',
};

beforeEach(() => {
  vi.spyOn(credentialService, 'listCredentials').mockResolvedValue({ success: true, data: [row] } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const controls = async () => {
  await screen.findByText('prod-ssh');
  return {
    create: screen.queryByRole('button', { name: /create credential/i }),
    edit: screen.queryByTitle('Edit'),
    del: screen.queryByTitle('Delete'),
    view: screen.queryByTitle('View Details'),
  };
};

// The server needs 'write' for credential create, update and delete (rest/routes/unified-credential.routes.ts); read-only roles only look.
describe('Credentials write controls by role', () => {
  it('a viewer can open a credential but sees no create, edit or delete', async () => {
    auth.role = 'viewer';
    const c = await (render(<Credentials />), controls());
    expect(c.view).toBeInTheDocument();
    expect([c.create, c.edit, c.del]).toEqual([null, null, null]);
  });

  it.each(['operator', 'admin'])('an %s sees create, edit and delete', async (role) => {
    auth.role = role;
    const c = await (render(<Credentials />), controls());
    expect(c.create).toBeInTheDocument();
    expect(c.edit).toBeInTheDocument();
    expect(c.del).toBeInTheDocument();
  });
});
