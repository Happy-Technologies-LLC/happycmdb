// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// The credential dialogs: delete (a data write), the detail hand-off to edit and delete, and Escape inside an open select.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { credentialService } from '@/services/credential.service';
import { Credentials } from './Credentials';

const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => toast }));
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => true }));
vi.mock('@happy-technologies/design-system', async (importOriginal) => ({ ...(await importOriginal<object>()), Icon: () => null, Eyebrow: () => null }));

const summary = { id: 'c1', name: 'prod-ssh', protocol: 'ssh_key', scope: 'universal', tags: [], created_at: '2026-10-01T00:00:00Z' };
const other = { ...summary, id: 'c2', name: 'staging-ssh' };
const full = (id: string, name: string, usage?: number) =>
  ({ ...summary, id, name, credentials: { username: 'svc' }, usage_count: usage }) as never;

let usage: number | undefined;
beforeEach(() => {
  usage = undefined;
  vi.spyOn(credentialService, 'listCredentials').mockResolvedValue({ success: true, data: [summary, other] } as never);
  vi.spyOn(credentialService, 'getCredential').mockImplementation(async (id: string) =>
    full(id, id === 'c1' ? 'prod-ssh' : 'staging-ssh', usage));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toast.showToast.mockClear();
});

const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr')!;
const openDelete = async (name: string) => {
  render(<Credentials />);
  fireEvent.click(within(await rowOf(name)).getByTitle('Delete'));
  return screen.findByRole('dialog', { name: 'Delete credential' });
};

describe('credential delete confirmation', () => {
  it('deletes nothing until confirmed, then deletes the credential that was chosen', async () => {
    const remove = vi.spyOn(credentialService, 'deleteCredential').mockResolvedValue(undefined as never);
    const dialog = await openDelete('staging-ssh');
    expect(within(dialog).getByText('Are you sure you want to delete "staging-ssh"?')).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(remove).toHaveBeenCalledWith('c2');
    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('Credential deleted successfully', 'success'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cancel deletes nothing and closes the dialog', async () => {
    const remove = vi.spyOn(credentialService, 'deleteCredential');
    const dialog = await openDelete('prod-ssh');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
  });

  it('a refused delete keeps the dialog open and toasts the server message', async () => {
    vi.spyOn(credentialService, 'deleteCredential').mockRejectedValue({ response: { data: { message: 'In use' } } });
    const dialog = await openDelete('prod-ssh');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toast.showToast).toHaveBeenCalledWith('In use', 'error'));
    expect(screen.getByRole('dialog', { name: 'Delete credential' })).toBeInTheDocument();
  });

  it('both buttons are disabled while the delete is in flight, so it cannot be sent twice', async () => {
    const remove = vi.spyOn(credentialService, 'deleteCredential').mockReturnValue(new Promise(() => undefined));
    const dialog = await openDelete('prod-ssh');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    const confirm = await within(dialog).findByRole('button', { name: 'Deleting...' });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.click(confirm);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it.each([
    [undefined, null],
    [0, null],
    [1, 'Warning: This credential is used by 1 discovery definition. Deleting it may affect those definitions.'],
    [3, 'Warning: This credential is used by 3 discovery definitions. Deleting it may affect those definitions.'],
  ])('usage count %s shows the warning %s', async (count, warning) => {
    usage = count;
    const dialog = await openDelete('prod-ssh');
    if (warning) expect(dialog).toHaveTextContent(warning);
    else expect(within(dialog).queryByText(/Warning/)).not.toBeInTheDocument();
  });
});

describe('credential detail hand-off', () => {
  const openDetail = async (name: string) => {
    render(<Credentials />);
    fireEvent.click(within(await rowOf(name)).getByTitle('View Details'));
    return screen.findByRole('dialog', { name: 'Credential details' });
  };

  it('Edit closes the detail and opens the edit form for that credential', async () => {
    const detail = await openDetail('staging-ssh');
    fireEvent.click(within(detail).getByRole('button', { name: 'Edit' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit credential' });
    expect(within(edit).getByLabelText(/^name/i)).toHaveValue('staging-ssh');
    expect(screen.queryByRole('dialog', { name: 'Credential details' })).not.toBeInTheDocument();
  });

  it('Delete closes the detail and asks to delete that credential', async () => {
    const remove = vi.spyOn(credentialService, 'deleteCredential').mockResolvedValue(undefined as never);
    const detail = await openDetail('staging-ssh');
    fireEvent.click(within(detail).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete credential' });
    expect(within(dialog).getByText('Are you sure you want to delete "staging-ssh"?')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Credential details' })).not.toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
  });
});

// The design-system dialog closes on any document Escape; a select's own Escape must close only its listbox.
describe('Escape inside an open select', () => {
  const openCreate = async () => {
    render(<Credentials />);
    fireEvent.click(await screen.findByRole('button', { name: /create credential/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Create credential' });
    fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: 'typed-name' } });
    return dialog;
  };

  it.each(['protocol', 'scope'])('closes the %s listbox only, keeping the dialog and what was typed', async (id) => {
    const dialog = await openCreate();
    const trigger = document.getElementById(id)!;
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Create credential' })).toBe(dialog);
    expect(within(dialog).getByLabelText(/^name/i)).toHaveValue('typed-name');
  });

  it('a second Escape, with no listbox open, still closes the dialog', async () => {
    await openCreate();
    const trigger = document.getElementById('protocol')!;
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'Escape' });
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Escape in the name field still closes the dialog', async () => {
    const dialog = await openCreate();
    fireEvent.keyDown(within(dialog).getByLabelText(/^name/i), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
