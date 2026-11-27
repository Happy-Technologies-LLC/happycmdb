// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios, { AxiosError, type AxiosAdapter } from 'axios';
import { BrowserRouter } from 'react-router-dom';
import { ForbiddenHost } from '@/components/layout/ForbiddenHost';
import {
  credentialService,
  type CredentialSetSummary,
  type UnifiedCredentialSummary,
} from '@/services/credential.service';
import { CredentialSetList } from './CredentialSetList';

const auth = vi.hoisted(() => ({ role: 'viewer' }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => toast }));
vi.mock('@/utils/logger', () => ({ logClientError: vi.fn() }));

const credential = (id: string, name: string, protocol: string, scope: string, description?: string) =>
  ({
    id,
    name,
    description,
    protocol,
    scope,
    affinity: {},
    tags: [],
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-10-01T10:00:00Z',
  }) as unknown as UnifiedCredentialSummary;

const SSH = credential('c1', 'Prod SSH key', 'ssh_key', 'global', 'Root key for production');
const PASSWORD = credential('c2', 'Staging password', 'ssh_password', 'network');

const set = (over: Partial<CredentialSetSummary>): CredentialSetSummary => ({
  id: 's1',
  name: 'Production SSH',
  description: 'Tried in order',
  credentials: [SSH, PASSWORD],
  strategy: 'sequential',
  stop_on_success: true,
  tags: ['prod', 'ssh', 'linux'],
  created_at: new Date('2026-10-02T09:30:00Z'),
  updated_at: new Date('2026-10-02T09:30:00Z'),
  ...over,
});
const PROD = set({});
const CLOUD = set({ id: 's2', name: 'Cloud audit', description: '', credentials: [SSH], strategy: 'parallel', tags: [] });

const http = () =>
  (credentialService as unknown as { axiosInstance: ReturnType<typeof axios.create> }).axiosInstance.defaults;
const realAdapter = http().adapter;

const never = () => new Promise<never>(() => undefined);
const mount = (ui = <CredentialSetList />) => render(<BrowserRouter>{ui}</BrowserRouter>);
const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

beforeEach(() => {
  auth.role = 'viewer';
  window.history.replaceState({}, '', '/');
  vi.spyOn(credentialService, 'getCredentialSets').mockResolvedValue([PROD, CLOUD]);
  vi.spyOn(credentialService, 'listCredentials').mockResolvedValue({
    success: true,
    data: [SSH, PASSWORD],
    count: 2,
  } as never);
});
afterEach(() => {
  http().adapter = realAdapter;
  cleanup();
  vi.restoreAllMocks();
  toast.showToast.mockClear();
});

describe('CredentialSetList by role', () => {
  it('a viewer sees the sets and the read-only detail action, and no Create, Edit or Delete', async () => {
    mount();

    expect(await screen.findByText('Production SSH')).toBeInTheDocument();
    expect(within(row('Production SSH')).getByRole('button', { name: 'View Details' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create Set' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('an operator sees Create Set and Edit and Delete on every row', async () => {
    auth.role = 'operator';
    mount();

    await screen.findByText('Production SSH');
    expect(screen.getByRole('button', { name: 'Create Set' })).toBeInTheDocument();
    for (const name of ['Production SSH', 'Cloud audit']) {
      expect(within(row(name)).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
      expect(within(row(name)).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    }
  });
});

describe('CredentialSetList rows', () => {
  it('shows strategy, credential count (singular and plural), two tags with the overflow count, and a dash for none', async () => {
    mount();

    await screen.findByText('Production SSH');
    const prod = within(row('Production SSH'));
    expect(prod.getByText('Sequential')).toBeInTheDocument();
    expect(prod.getByText('2 credentials')).toBeInTheDocument();
    expect(prod.getByText('prod')).toBeInTheDocument();
    expect(prod.getByText('ssh')).toBeInTheDocument();
    expect(prod.queryByText('linux')).toBeNull();
    expect(prod.getByText('+1')).toBeInTheDocument();
    const cloud = within(row('Cloud audit'));
    expect(cloud.getByText('1 credential')).toBeInTheDocument();
    expect(cloud.getByText('-')).toBeInTheDocument();
  });

  it('opens the detail dialog from a row click and from the keyboard, listing credentials in order', async () => {
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByText('Production SSH'));
    const dialog = await screen.findByRole('dialog', { name: 'Credential Set Details' });
    expect(within(dialog).getByText('Credentials (2)')).toBeInTheDocument();
    const names = within(dialog).getAllByText(/^(Prod SSH key|Staging password)$/).map((el) => el.textContent);
    expect(names).toEqual(['Prod SSH key', 'Staging password']);
    expect(within(dialog).getByText('SSH Key')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    row('Cloud audit').focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Credential Set Details' })).toBeInTheDocument();
  });
});

describe('CredentialSetList write actions call the service with the same arguments', () => {
  beforeEach(() => {
    auth.role = 'operator';
  });

  it('creates a set from the dialog form', async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(credentialService, 'createCredentialSet').mockResolvedValue(PROD);
    mount();

    await user.click(await screen.findByRole('button', { name: 'Create Set' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create Credential Set' });
    await user.type(within(dialog).getByLabelText(/^Name/), 'New set');
    await user.click(await within(dialog).findByRole('button', { name: /Staging password/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save Set' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith({
      name: 'New set',
      description: '',
      credential_ids: ['c2'],
      strategy: 'sequential',
      stop_on_success: true,
      tags: [],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.showToast).toHaveBeenCalledWith('Credential set created successfully', 'success');
  });

  it('updates the chosen set by id with the edited form values', async () => {
    const user = userEvent.setup();
    const update = vi.spyOn(credentialService, 'updateCredentialSet').mockResolvedValue(PROD);
    mount();

    await screen.findByText('Production SSH');
    await user.click(within(row('Production SSH')).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Credential Set' });
    const name = within(dialog).getByLabelText(/^Name/);
    expect(name).toHaveValue('Production SSH');
    await user.clear(name);
    await user.type(name, 'Prod SSH v2');
    await user.click(within(dialog).getByRole('button', { name: 'Save Set' }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith('s1', {
      name: 'Prod SSH v2',
      description: 'Tried in order',
      credential_ids: ['c1', 'c2'],
      strategy: 'sequential',
      stop_on_success: true,
      tags: ['prod', 'ssh', 'linux'],
    });
  });

  it('deletes only after the confirmation dialog, by id', async () => {
    const user = userEvent.setup();
    const remove = vi.spyOn(credentialService, 'deleteCredentialSet').mockResolvedValue(undefined as never);
    mount();

    await screen.findByText('Production SSH');
    await user.click(within(row('Cloud audit')).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Credential Set' });
    expect(remove).not.toHaveBeenCalled();
    expect(within(dialog).getByText('Are you sure you want to delete "Cloud audit"?')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith('s2'));
    expect(toast.showToast).toHaveBeenCalledWith('Credential set deleted successfully', 'success');
  });

  it('cancelling the delete confirmation calls nothing', async () => {
    const user = userEvent.setup();
    const remove = vi.spyOn(credentialService, 'deleteCredentialSet');
    mount();

    await screen.findByText('Production SSH');
    await user.click(within(row('Production SSH')).getByRole('button', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });

  it('shows the server message and keeps the dialog open when a create is refused', async () => {
    const user = userEvent.setup();
    vi.spyOn(credentialService, 'createCredentialSet').mockRejectedValue({
      response: { data: { message: 'Name already exists' } },
    });
    mount();

    await user.click(await screen.findByRole('button', { name: 'Create Set' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create Credential Set' });
    await user.type(within(dialog).getByLabelText(/^Name/), 'Dup');
    await user.click(await within(dialog).findByRole('button', { name: /Staging password/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save Set' }));

    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('Name already exists', 'error'));
    expect(screen.getByRole('dialog', { name: 'Create Credential Set' })).toBeInTheDocument();
  });
});

describe('CredentialSetList delete warning shows the usage count only when it is a real number above zero', () => {
  beforeEach(() => {
    auth.role = 'operator';
  });

  const openDelete = async (sets: CredentialSetSummary[]) => {
    const user = userEvent.setup();
    vi.spyOn(credentialService, 'getCredentialSets').mockResolvedValue(sets);
    mount();
    await screen.findByText(sets[0].name);
    await user.click(within(row(sets[0].name)).getByRole('button', { name: 'Delete' }));
    return screen.findByRole('dialog', { name: 'Delete Credential Set' });
  };

  it('an unknown count (undefined) shows no warning and no zero', async () => {
    const dialog = await openDelete([set({ usage_count: undefined })]);

    expect(within(dialog).queryByText(/Warning/)).toBeNull();
    expect(dialog.textContent).not.toMatch(/\b0\b/);
  });

  it('a count of 0 shows no warning and no stray 0', async () => {
    const dialog = await openDelete([set({ usage_count: 0 })]);

    expect(within(dialog).queryByText(/Warning/)).toBeNull();
    expect(within(dialog).getByText('Are you sure you want to delete "Production SSH"?').parentElement?.textContent).not.toMatch(
      /\b0\b/,
    );
  });

  it('a count of 1 is singular and a count of 3 is plural', async () => {
    let dialog = await openDelete([set({ usage_count: 1 })]);
    expect(dialog).toHaveTextContent(
      'Warning: This credential set is used by 1 discovery definition. Deleting it may affect those definitions.',
    );

    cleanup();
    dialog = await openDelete([set({ usage_count: 3 })]);
    expect(dialog).toHaveTextContent(
      'Warning: This credential set is used by 3 discovery definitions. Deleting it may affect those definitions.',
    );
  });
});

describe('CredentialSetList states', () => {
  it('shows a loading status, not an empty table, while the sets load', () => {
    vi.spyOn(credentialService, 'getCredentialSets').mockImplementation(never);
    mount();

    expect(screen.getByRole('status')).toHaveTextContent('Loading credential sets');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/No credential sets found/)).toBeNull();
  });

  it('shows the empty state when there are no sets', async () => {
    vi.spyOn(credentialService, 'getCredentialSets').mockResolvedValue([]);
    mount();

    expect(await screen.findByText('No credential sets found. Create your first set to get started.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows a retryable error, not an empty table, when the read fails; Try again reloads', async () => {
    const user = userEvent.setup();
    const read = vi
      .spyOn(credentialService, 'getCredentialSets')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce([PROD]);
    mount();

    expect(await screen.findByText('Could not load credential sets')).toBeInTheDocument();
    expect(screen.getByText('network down')).toBeInTheDocument();
    expect(screen.queryByText(/No credential sets found/)).toBeNull();
    expect(toast.showToast).toHaveBeenCalledWith('Failed to load credential sets', 'error');

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Production SSH')).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Could not load credential sets')).toBeNull();
  });

  it('a server 403 on the read reaches the global banner and the page says it is not permitted, with no spinner', async () => {
    vi.restoreAllMocks();
    auth.role = 'viewer';
    const refuse: AxiosAdapter = async (config) => {
      throw new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', config, {}, {
        status: 403,
        statusText: 'Forbidden',
        data: { _error: 'Forbidden', _message: "Permission 'read' required" },
        headers: {},
        config,
      });
    };
    http().adapter = refuse;
    mount(
      <>
        <ForbiddenHost />
        <CredentialSetList />
      </>,
    );

    expect(await screen.findByText('No access to credential sets')).toBeInTheDocument();
    expect(await screen.findByText('Access denied.')).toBeInTheDocument();
    expect(screen.getAllByText("Permission 'read' required").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create Set' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
