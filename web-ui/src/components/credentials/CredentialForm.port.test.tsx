// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-444 K1: a typed port is sent as a JSON number, an empty one is omitted, and a 400 toasts the fixed _message. Forms are submitted directly, past the native required-field gate.
import { expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const { request, showToast } = vi.hoisted(() => ({ request: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }, showToast: vi.fn() }));
vi.mock('axios', async () => ({ ...(await vi.importActual<object>('axios')), default: { create: () => ({ ...request, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } } }) } }));
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ showToast }) }));
vi.mock('@happy-technologies/design-system', () => ({ Icon: () => null, Eyebrow: () => null }));
import { CredentialForm } from './CredentialForm';
import { Credentials } from '@/pages/Credentials';
import { PROTOCOL_DISPLAY_NAMES } from '@/lib/credential-display';

const save = () => fireEvent.submit(screen.getByRole('button', { name: /save credential/i }).closest('form')!);
const submitPort = async (protocol: string, port: string) => {
  const onSubmit = vi.fn();
  cleanup();
  render(<CredentialForm credential={{ id: 'c1', name: 'n', protocol, scope: 'universal', credentials: { username: 'svc' }, tags: [] } as never} onSubmit={onSubmit} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByLabelText(/^port$/i), { target: { value: port } });
  save();
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  return onSubmit.mock.calls[0][0].credentials as Record<string, unknown>;
};
it.each(Object.keys(PROTOCOL_DISPLAY_NAMES).filter((protocol) => /^(ssh_|winrm$)/.test(protocol)))('%s posts a typed port as a JSON number and omits an empty one (HAP-444 K1)', async (protocol) => {
  expect(JSON.stringify(await submitPort(protocol, String(2222)))).toContain('"port":2222');
  expect(await submitPort(protocol, '')).not.toHaveProperty('port');
});
it('a refused create shows the fixed server _message in the toast (HAP-444 K1)', async () => {
  request.get.mockResolvedValue({ data: { success: true, data: [] } });
  request.post.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { _message: 'Invalid SSH port' } } }));
  render(<Credentials />);
  fireEvent.click(screen.getByRole('button', { name: /create credential/i }));
  fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: 'n' } });
  save();
  await waitFor(() => expect(showToast).toHaveBeenCalledWith('Invalid SSH port', 'error'));
});
it('a refused update shows the fixed server _message in the edit-dialog toast (HAP-444 K1)', async () => {
  cleanup(); showToast.mockClear();
  const cred = { id: 'c1', name: 'n', protocol: Object.keys(PROTOCOL_DISPLAY_NAMES).find((p) => /^ssh_/.test(p)), scope: 'universal', credentials: { username: 'svc' }, tags: [], created_at: new Date().toISOString() };
  request.get.mockImplementation(async (url: string) => ({ data: { success: true, data: url.endsWith(cred.id) ? cred : [cred] } }));
  request.put.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { _message: 'Invalid SSH port' } } }));
  render(<Credentials />);
  fireEvent.click(await screen.findByTitle('Edit'));
  await screen.findByRole('button', { name: /save credential/i });
  save();
  await waitFor(() => expect(showToast).toHaveBeenCalledWith('Invalid SSH port', 'error'));
});
