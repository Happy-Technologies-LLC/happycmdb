// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1227: the edit dialog never seeds the secret from the redacted read; it sends credentials only when a new payload was entered.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
const { request, showToast } = vi.hoisted(() => ({ request: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }, showToast: vi.fn() }));
vi.mock('axios', async () => ({ ...(await vi.importActual<object>('axios')), default: { create: () => ({ ...request, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } }) } }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('@happy-technologies/design-system', async (importOriginal) => ({ ...(await importOriginal<object>()), Icon: () => null, Eyebrow: () => null }));
import { Credentials } from './Credentials';
import { domLeaks, secretMarker } from '@/tests/utils/secretDom';
import { PROTOCOL_DISPLAY_NAMES } from '@/lib/credential-display';
// These screens gate their write controls on the signed-in role (HAP-1252 S1); this test is about the writes, so the user may write.
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => true }));

// Built at runtime from neutral parts. It stands in for the server's redaction string, which the web-ui cannot import;
// any string spread into an object reproduces the defect, and the api-server test pins the real constant.
const [READ, ID, SEC] = ['read', 'id', 'sec'].map((part) => ['h1227', part, 'mark'].join('-'));
const cred = { id: 'c1', name: 'n', protocol: Object.keys(PROTOCOL_DISPLAY_NAMES).find((p) => /^aws_/.test(p)), scope: 'universal', tags: [], created_at: new Date().toISOString() };

beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  request.get.mockImplementation(async (url: string) => ({ data: { success: true, data: url.endsWith(cred.id) ? { ...cred, credentials: READ } : [cred] } }));
  request.put.mockResolvedValue({ data: { success: true, data: { ...cred, credentials: READ } } });
});
const openEdit = async () => {
  render(<Credentials />);
  fireEvent.click(await screen.findByTitle('Edit'));
  return (await screen.findByRole('button', { name: /save credential/i })).closest('form')!;
};
const putBody = async () => {
  await waitFor(() => expect(request.put).toHaveBeenCalledTimes(1));
  const body = request.put.mock.calls[0][1] as Record<string, unknown>;
  expect(JSON.stringify(body)).not.toContain(READ);
  return body;
};

it('a metadata-only edit saves past the empty secret fields and omits credentials (HAP-1227)', async () => {
  await openEdit();
  fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'renamed' } });
  fireEvent.click(screen.getByRole('button', { name: /save credential/i }));
  expect(Object.keys(await putBody()).sort()).toEqual(['description', 'name', 'tags']);
});

it('changing one secret field requires the full set and never sends index keys from the redacted read (HAP-1227)', async () => {
  const form = await openEdit();
  fireEvent.change(screen.getByLabelText(/secret access key/i), { target: { value: SEC } });
  expect(form.checkValidity()).toBe(false);
  fireEvent.submit(form);
  expect((await putBody()).credentials).toEqual({ secret_access_key: SEC });
});

it('a new full secret payload is sent as that object only (HAP-1227)', async () => {
  await openEdit();
  fireEvent.change(screen.getByLabelText(/access key id/i), { target: { value: ID } });
  fireEvent.change(screen.getByLabelText(/secret access key/i), { target: { value: SEC } });
  fireEvent.click(screen.getByRole('button', { name: /save credential/i }));
  expect((await putBody()).credentials).toEqual({ access_key_id: ID, secret_access_key: SEC });
});

// The create dialog is a DS Dialog: it portals to document.body, outside the form root, so the DOM check runs on the whole body.
const openCreate = async (protocol: string) => {
  request.get.mockResolvedValue({ data: { success: true, data: [] } });
  render(<Credentials />);
  fireEvent.click(await screen.findByRole('button', { name: /create credential/i }));
  const trigger = document.getElementById('protocol')!;
  fireEvent.click(trigger);
  fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: PROTOCOL_DISPLAY_NAMES[protocol as keyof typeof PROTOCOL_DISPLAY_NAMES] }));
  expect(trigger).toHaveTextContent(PROTOCOL_DISPLAY_NAMES[protocol as keyof typeof PROTOCOL_DISPLAY_NAMES]);
};
const typeInto = (id: string, value: string) => {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  expect(el.closest('[role="dialog"]')).not.toBeNull();
  fireEvent.change(el, { target: { value } });
  return el;
};

describe('secrets typed beside the design-system fields never reach the DOM (HAP-1213)', () => {
  it('Input class: text fields beside the secrets of aws_iam, with the dialog portal open', async () => {
    await openCreate('aws_iam');
    const [id, key, token] = ['id', 'key', 'token'].map(secretMarker);
    typeInto('region', 'eu-west-1');
    typeInto('access_key_id', id);
    typeInto('secret_access_key', key);
    typeInto('session_token', token);
    expect((document.getElementById('secret_access_key') as HTMLInputElement).value).toBe(key);
    for (const marker of [id, key, token]) expect(domLeaks(marker, document.body)).toEqual([]);
  });

  it('Select class: protocol and SNMP selects, then every SNMP v3 secret', async () => {
    await openCreate('snmp_v3');
    const [auth, priv] = ['auth', 'priv'].map(secretMarker);
    for (const [selectId, option] of [['auth_protocol', 'MD5'], ['priv_protocol', 'DES']]) {
      fireEvent.click(document.getElementById(selectId)!);
      fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: option }));
      expect(document.getElementById(selectId)).toHaveTextContent(option);
    }
    typeInto('auth_password', auth);
    typeInto('priv_password', priv);
    for (const marker of [auth, priv]) expect(domLeaks(marker, document.body)).toEqual([]);
  });

  it('Textarea class: the certificate textareas beside the private key and passphrase', async () => {
    await openCreate('certificate');
    const [key, pass] = ['key', 'pass'].map(secretMarker);
    typeInto('certificate', '-----BEGIN CERTIFICATE-----');
    typeInto('ca_certificate', '-----BEGIN CERTIFICATE-----');
    typeInto('private_key', key);
    typeInto('passphrase', pass);
    expect((document.getElementById('private_key') as HTMLTextAreaElement).value).toBe(key);
    for (const marker of [key, pass]) expect(domLeaks(marker, document.body)).toEqual([]);
  });

  it('the secret toggle reveals the value in the field without mirroring it into the dialog', async () => {
    await openCreate('ssh_password');
    const marker = secretMarker('reveal');
    const password = typeInto('password', marker) as HTMLInputElement;
    fireEvent.click(password.nextElementSibling!);
    expect(password.type).toBe('text');
    expect(domLeaks(marker, document.body)).toEqual([]);
  });
});
