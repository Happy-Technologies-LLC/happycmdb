// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { credentialService } from '@/services/credential.service';
import { ForbiddenHost } from '@/components/layout/ForbiddenHost';
import { Credentials } from './Credentials';

const auth = vi.hoisted(() => ({ role: 'viewer' }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
// The credential client is the real one (its session interceptor reports a 403 to the shell); only the wire answers 403.
vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  const refuse = (config: import('axios').InternalAxiosRequestConfig) =>
    Promise.reject(new actual.AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', config, {}, {
      status: 403, statusText: 'Forbidden', headers: {}, config, data: { _error: 'Forbidden', _message: "Permission 'read' required" },
    }));
  return { ...actual, default: { ...actual.default, create: (cfg: object) => actual.default.create({ ...cfg, adapter: refuse }) } };
});

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

const forbidden = Object.assign(new Error('Request failed with status code 403'), {
  response: { status: 403, data: { _message: "Permission 'read' required" } },
});

describe('Credentials list states', () => {
  it('loading: shows a labelled loading status, not an empty list', async () => {
    auth.role = 'operator';
    vi.spyOn(credentialService, 'listCredentials').mockReturnValue(new Promise(() => undefined));
    render(<Credentials />);
    expect(await screen.findByRole('status')).toHaveTextContent(/loading credentials/i);
    expect(screen.queryByText(/no credentials found/i)).not.toBeInTheDocument();
  });

  it('empty: says there are no credentials, and not that the read failed', async () => {
    vi.spyOn(credentialService, 'listCredentials').mockResolvedValue({ success: true, data: [] } as never);
    render(<Credentials />);
    expect(await screen.findByText(/no credentials found/i)).toBeInTheDocument();
    expect(screen.queryByText(/could not load/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('error: shows the failure with a retry, never an empty list, and retry reloads the rows', async () => {
    const list = vi.spyOn(credentialService, 'listCredentials')
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockResolvedValue({ success: true, data: [row] } as never);
    render(<Credentials />);
    expect(await screen.findByText('Could not load credentials')).toBeInTheDocument();
    expect(screen.getByText('Network Error')).toBeInTheDocument();
    expect(screen.queryByText(/no credentials found/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('prod-ssh')).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Could not load credentials')).not.toBeInTheDocument();
  });

  it('error after rows were shown: the stale rows go, the error shows', async () => {
    vi.spyOn(credentialService, 'listCredentials')
      .mockResolvedValueOnce({ success: true, data: [row] } as never)
      .mockRejectedValue(new Error('Network Error'));
    render(<Credentials />);
    await screen.findByText('prod-ssh');
    fireEvent.change(screen.getByRole('combobox', { name: 'Category' }), { target: { value: 'discovery' } });
    expect(await screen.findByText('Could not load credentials')).toBeInTheDocument();
    expect(screen.queryByText('prod-ssh')).not.toBeInTheDocument();
  });

  it('403 on the read: a plain not-permitted state with the server reason, no spinner, no write control', async () => {
    auth.role = 'viewer';
    vi.spyOn(credentialService, 'listCredentials').mockRejectedValue(forbidden);
    render(<Credentials />);
    expect(await screen.findByText('No access to credentials')).toBeInTheDocument();
    expect(screen.getByText("Permission 'read' required")).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create credential/i })).not.toBeInTheDocument();
  });

  it('403 from the server on the read reaches the global ForbiddenHost and the page shows its own state', async () => {
    auth.role = 'viewer';
    vi.mocked(credentialService.listCredentials).mockRestore(); // the real client, whose wire answers 403
    render(<MemoryRouter><ForbiddenHost /><Credentials /></MemoryRouter>);
    expect(await screen.findByText('Access denied.')).toBeInTheDocument();
    expect(await screen.findByText('No access to credentials')).toBeInTheDocument();
    expect(screen.getAllByText("Permission 'read' required")).toHaveLength(2);
    expect(screen.queryByRole('status', { name: /loading/i })).not.toBeInTheDocument();
  });

  it('an unreported usage count reads "-", not a made-up 0; a real 0 and 1 read as such', async () => {
    vi.spyOn(credentialService, 'listCredentials').mockResolvedValue({ success: true, data: [
      { ...row, id: 'a', name: 'unknown-use' },
      { ...row, id: 'b', name: 'zero-use', usage_count: 0 },
      { ...row, id: 'c', name: 'one-use', usage_count: 1 },
    ] } as never);
    render(<Credentials />);
    const cells = async (name: string) => (await screen.findByText(name)).closest('tr')!.querySelectorAll('td');
    expect((await cells('unknown-use'))[2]).toHaveTextContent(/^-$/);
    expect((await cells('zero-use'))[2]).toHaveTextContent(/^0 definitions$/);
    expect((await cells('one-use'))[2]).toHaveTextContent(/^1 definition$/);
  });
});
