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
import { CredentialSetForm } from './CredentialSetForm';

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
const AWS = credential('c3', 'AWS read-only', 'aws_iam', 'cloud_provider');

const listResponse = (data: UnifiedCredentialSummary[]) => ({ success: true, data, count: data.length });

const existing: CredentialSetSummary = {
  id: 's1',
  name: 'Production SSH',
  description: 'Tried in order',
  credentials: [PASSWORD, SSH],
  strategy: 'adaptive',
  stop_on_success: false,
  tags: ['prod'],
  created_at: new Date('2026-10-02T09:30:00Z'),
  updated_at: new Date('2026-10-02T09:30:00Z'),
};

const mount = (props: Partial<React.ComponentProps<typeof CredentialSetForm>> = {}) => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(<CredentialSetForm onSubmit={onSubmit} onCancel={onCancel} {...props} />);
  return { onSubmit, onCancel };
};

const http = () =>
  (credentialService as unknown as { axiosInstance: ReturnType<typeof axios.create> }).axiosInstance.defaults;
const realAdapter = http().adapter;

const never = () => new Promise<never>(() => undefined);

beforeEach(() => {
  vi.spyOn(credentialService, 'listCredentials').mockResolvedValue(listResponse([SSH, PASSWORD, AWS]) as never);
});
afterEach(() => {
  http().adapter = realAdapter;
  cleanup();
  vi.restoreAllMocks();
});

describe('CredentialSetForm submit', () => {
  it('submits exactly the entered values, with credentials in the chosen order', async () => {
    const user = userEvent.setup();
    const { onSubmit } = mount();

    await user.type(await screen.findByLabelText(/^Name/), 'Prod set');
    await user.type(screen.getByLabelText('Description'), 'Hosts in prod');
    await user.click(await screen.findByRole('button', { name: /Prod SSH key/ }));
    await user.click(await screen.findByRole('button', { name: /AWS read-only/ }));
    // The selected list is [SSH, AWS]; move AWS above SSH.
    const selected = screen.getByText('Selected Credentials (in order)').parentElement as HTMLElement;
    const awsRow = within(selected).getByText('AWS read-only').closest('div[class*="relative"]') as HTMLElement;
    await user.click(within(awsRow).getByRole('button', { name: 'Move up' }));

    await user.click(screen.getByRole('combobox', { name: /Strategy/ }));
    await user.click(screen.getByRole('option', { name: 'Parallel' }));
    await user.click(screen.getByRole('switch', { name: 'Stop on Success' }));
    await user.type(screen.getByLabelText('Tags'), 'prod{Enter}linux{Enter}prod{Enter}');
    await user.click(
      within(screen.getByText('linux').closest('span') as HTMLElement).getByRole('button', { name: 'Remove' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save Set' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Prod set',
      description: 'Hosts in prod',
      credential_ids: ['c3', 'c1'],
      strategy: 'parallel',
      stop_on_success: false,
      tags: ['prod'],
    });
  });

  it('refuses a blank name and says so, without calling onSubmit', async () => {
    const user = userEvent.setup();
    const { onSubmit } = mount();

    await user.click(await screen.findByRole('button', { name: /Prod SSH key/ }));
    await user.click(screen.getByRole('button', { name: 'Save Set' }));

    expect(await screen.findByText('Name is required')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps Save disabled and explains why until one credential is selected', async () => {
    const user = userEvent.setup();
    mount();

    expect(await screen.findByText('Please select at least one credential')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Set' })).toBeDisabled();

    await user.click(await screen.findByRole('button', { name: /AWS read-only/ }));

    expect(screen.queryByText('Please select at least one credential')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save Set' })).toBeEnabled();
  });

  it('prefills an existing set and submits its changes keeping the stored order', async () => {
    const user = userEvent.setup();
    const { onSubmit } = mount({ set: existing });

    const name = await screen.findByLabelText(/^Name/);
    expect(name).toHaveValue('Production SSH');
    expect(screen.getByRole('combobox', { name: /Strategy/ })).toHaveTextContent('Adaptive');
    expect(screen.getByRole('switch', { name: 'Stop on Success' })).toHaveAttribute('aria-checked', 'false');

    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save Set' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Renamed',
      description: 'Tried in order',
      credential_ids: ['c2', 'c1'],
      strategy: 'adaptive',
      stop_on_success: false,
      tags: ['prod'],
    });
  });

  it('returns a removed credential to the available list and disables the end moves', async () => {
    const user = userEvent.setup();
    mount({ set: existing });

    const selected = (await screen.findByText('Selected Credentials (in order)')).parentElement as HTMLElement;
    const rows = within(selected).getAllByRole('button', { name: 'Move up' });
    expect(rows[0]).toBeDisabled();
    expect(within(selected).getAllByRole('button', { name: 'Move down' })[1]).toBeDisabled();

    await user.click(within(selected).getAllByRole('button', { name: 'Remove' })[0]);

    expect(within(selected).queryByText('Staging password')).toBeNull();
    expect(screen.getByRole('button', { name: /Staging password/ })).toBeInTheDocument();
  });

  it('cancels through onCancel and blocks both buttons while submitting', async () => {
    const user = userEvent.setup();
    const { onCancel } = mount();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    cleanup();
    mount({ isSubmitting: true });
    await screen.findByRole('button', { name: /Prod SSH key/ });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  });
});

describe('CredentialSetForm available credentials states', () => {
  it('shows a loading status while the credentials load', () => {
    vi.spyOn(credentialService, 'listCredentials').mockImplementation(never);
    mount();

    expect(screen.getByRole('status')).toHaveTextContent('Loading available credentials');
    expect(screen.queryByText(/No credentials available/)).toBeNull();
  });

  it('says there is nothing to pick when no credential exists', async () => {
    vi.spyOn(credentialService, 'listCredentials').mockResolvedValue(listResponse([]) as never);
    mount();

    expect(await screen.findByText('No credentials available. Create credentials first.')).toBeInTheDocument();
  });

  it('says every credential is added once all are selected', async () => {
    vi.spyOn(credentialService, 'listCredentials').mockResolvedValue(listResponse([SSH]) as never);
    const user = userEvent.setup();
    mount();

    await user.click(await screen.findByRole('button', { name: /Prod SSH key/ }));

    expect(screen.getByText('All credentials have been added')).toBeInTheDocument();
  });

  it('shows a retryable error, not an empty list, when the credentials fail to load', async () => {
    const list = vi
      .spyOn(credentialService, 'listCredentials')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(listResponse([SSH]) as never);
    const user = userEvent.setup();
    mount();

    expect(await screen.findByText('Could not load available credentials')).toBeInTheDocument();
    expect(screen.getByText('network down')).toBeInTheDocument();
    expect(screen.queryByText(/No credentials available/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: /Prod SSH key/ })).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('shows its own not-permitted state, with the server reason, when the read is refused with 403', async () => {
    vi.restoreAllMocks();
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
    window.history.replaceState({}, '', '/');
    render(
      <BrowserRouter>
        <ForbiddenHost />
        <CredentialSetForm onSubmit={vi.fn()} onCancel={vi.fn()} />
      </BrowserRouter>,
    );

    expect(await screen.findByText('No access to available credentials')).toBeInTheDocument();
    // the shell's banner carries the same server reason; the form shows no endless spinner
    expect(await screen.findByText('Access denied.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/No credentials available/)).toBeNull();
  });
});
