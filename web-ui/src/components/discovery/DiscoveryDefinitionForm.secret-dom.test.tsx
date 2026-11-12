// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1213: the new-SSH-credential secret lives in the input's value property only, never in the DOM tree,
// and is dropped when the user leaves "Create a new SSH credential".
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { domLeaks, secretMarker } from '@/tests/utils/secretDom';

const { request } = vi.hoisted(() => ({ request: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const saved = vi.hoisted((): { id: string; name: string; protocol: string }[] => []);
vi.mock('axios', () => ({ default: { create: () => ({
  ...request, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
}) } }));
vi.mock('../../hooks/useCredentials', () => ({
  useCredentials: () => ({ credentials: saved, loading: false, error: null, loadCredentials: vi.fn() }),
}));
// Radix Select does not open in jsdom; each item becomes a button that sets its Select's value.
vi.mock('../ui/select', async () => {
  const React = await import('react');
  const Ctx = React.createContext<(value: string) => void>(() => undefined);
  const Pass = ({ children }: { children?: ReactNode }): ReactElement => React.createElement(React.Fragment, null, children);
  return {
    Select: ({ onValueChange, children }: { onValueChange?: (value: string) => void; children?: ReactNode }) =>
      React.createElement(Ctx.Provider, { value: onValueChange ?? (() => undefined) }, children),
    SelectTrigger: Pass, SelectContent: Pass, SelectValue: () => null,
    SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => {
      const choose = React.useContext(Ctx);
      return React.createElement('button', { type: 'button', onClick: () => choose(value) }, children);
    },
  };
});

import DiscoveryDefinitionForm from './DiscoveryDefinitionForm';
import type { DiscoveryDefinitionInput } from '../../services/discovery.service';
// These screens gate their write controls on the signed-in role (HAP-1252 S1); this test is about the writes, so the user may write.
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => true }));

const onSubmit = vi.fn<(data: DiscoveryDefinitionInput) => void>();
beforeEach(() => {
  vi.clearAllMocks();
  saved.splice(0, saved.length, { id: 'cred-9', name: 'existing-ssh', protocol: 'ssh_password' });
});
afterEach(cleanup);

const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const secret = () => screen.getByLabelText(/^(password|private key)/i) as HTMLInputElement | HTMLTextAreaElement;
const choose = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

function renderSsh(): void {
  render(<DiscoveryDefinitionForm onSubmit={onSubmit} onCancel={vi.fn()} />);
  choose('SSH');
  type(/^name/i, 'web hosts');
  type(/target hosts/i, 'host1.example.com');
}

describe('DiscoveryDefinitionForm new SSH credential secret (HAP-1213)', () => {
  it('password: the typed secret stays out of the DOM tree and in the input value property', () => {
    renderSsh();
    const marker = secretMarker('ssh-pw');
    type(/^password/i, marker);
    type(/^password/i, `${marker}-more`);

    expect(secret().value).toBe(`${marker}-more`);
    expect(secret()).toHaveAttribute('type', 'password');
    expect(secret()).toHaveAttribute('autocomplete', 'new-password');
    expect(domLeaks(marker)).toEqual([]);
  });

  it('private key: the typed PEM stays out of the DOM tree and in the textarea value property', () => {
    renderSsh();
    choose(/private key \(pem\)/i);
    const marker = secretMarker('ssh-key');
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${marker}\n-----END OPENSSH PRIVATE KEY-----`;
    type(/private key \(pem text\)/i, pem);
    type(/private key \(pem text\)/i, `${pem}\n`);

    expect(secret().value).toBe(`${pem}\n`);
    expect(secret()).toHaveAttribute('autocomplete', 'off');
    expect(domLeaks(marker)).toEqual([]);
  });

  it.each([
    ['password', async () => undefined, /^password/i],
    ['private key', async () => choose(/private key \(pem\)/i), /private key \(pem text\)/i],
  ] as const)('%s: switching to an existing credential drops the secret, keeps non-secret fields, and submits without it', async (_mode, pick, label) => {
    renderSsh();
    await pick();
    type(/credential name/i, 'ssh-web');
    type(/username/i, 'deploy');
    const marker = secretMarker('switch');
    type(label, marker);
    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(marker);

    choose('existing-ssh');
    expect(screen.queryByLabelText(label)).toBeNull();
    expect(domLeaks(marker)).toEqual([]);

    // Back to "Create a new SSH credential": the secret is empty, the non-secret fields survived.
    choose('Create a new SSH credential');
    expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/credential name/i) as HTMLInputElement).value).toBe('ssh-web');
    expect((screen.getByLabelText(/username/i) as HTMLInputElement).value).toBe('deploy');
    expect(domLeaks(marker)).toEqual([]);

    // Away again and submit: the payload carries the existing id and nothing of the marker.
    choose('existing-ssh');
    fireEvent.click(screen.getByRole('button', { name: /create definition/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].credentialId).toBe('cred-9');
    expect(JSON.stringify(onSubmit.mock.calls[0][0])).not.toContain(marker);
    expect(request.post).not.toHaveBeenCalled();
  });

  it('leaving SSH for another provider drops the secret too', () => {
    renderSsh();
    const marker = secretMarker('provider');
    type(/^password/i, marker);

    choose('NMAP');
    choose('SSH');
    expect(secret().value).toBe('');
  });
});
