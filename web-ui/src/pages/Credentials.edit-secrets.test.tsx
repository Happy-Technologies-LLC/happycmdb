// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1227: the edit dialog never seeds the secret from the redacted read; it sends credentials only when a new payload was entered.
import { beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const { request, showToast } = vi.hoisted(() => ({ request: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }, showToast: vi.fn() }));
vi.mock('axios', async () => ({ ...(await vi.importActual<object>('axios')), default: { create: () => ({ ...request, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } }) } }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('@happy-technologies/design-system', () => ({ Icon: () => null, Eyebrow: () => null }));
import { Credentials } from './Credentials';
import { PROTOCOL_DISPLAY_NAMES } from '@/lib/credential-display';

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
