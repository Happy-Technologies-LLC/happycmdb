// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-774 S7 (C-12): the discovery form submits credential_id only and never logs a secret.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const MARKER = 'S7MARKER';
const PEM = `-----BEGIN OPENSSH PRIVATE KEY-----\n${MARKER}-key\n-----END OPENSSH PRIVATE KEY-----`;

const { request } = vi.hoisted(() => ({ request: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
const saved = vi.hoisted((): { id: string; name: string; protocol: string }[] => []);
vi.mock('axios', () => ({ default: { create: () => ({
  ...request, interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
}) } }));
vi.mock('../../hooks/useCredentials', () => ({
  useCredentials: () => ({ credentials: saved, loading: false, error: null, loadCredentials: vi.fn() }),
}));
// Radix Select does not open in jsdom; each item becomes a button that sets its Select's value.
// vi.mock factories are hoisted above static imports, so React must be imported inside the factory.
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
import { discoveryService, type DiscoveryDefinitionInput } from '../../services/discovery.service';

const spies: MockInstance[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  saved.splice(0);
  request.post.mockImplementation((path: string) =>
    Promise.resolve({ data: { data: path === '/credentials' ? { id: 'cred-1' } : { id: 'def-1', is_active: true } } }));
  for (const level of ['log', 'info', 'debug', 'warn', 'error'] as const) {
    spies.push(vi.spyOn(console, level).mockImplementation(() => undefined));
  }
});
afterEach(() => {
  cleanup();
  // (c) no console level ever sees the marker, in any argument, at any depth.
  const calls = spies.splice(0).map((spy) => {
    const seen = inspect(spy.mock.calls, { depth: null });
    spy.mockRestore();
    return seen;
  });
  expect(calls.join('\n')).not.toContain(MARKER);
});

interface Posted { credential_id?: string; config?: unknown; credentials?: Record<string, unknown> }
const submitToService = vi.fn((data: DiscoveryDefinitionInput): void => {
  void discoveryService.createDefinition(data);
});
const type = (label: RegExp, value: string): boolean => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const posted = (path: string): Posted | undefined =>
  (request.post.mock.calls as [string, Posted][]).find(([p]) => p === path)?.[1];

// The password goes in first so that on base, the inline config field logs it before the new fields are missing.
function renderSsh(password?: string, adHoc?: (data: DiscoveryDefinitionInput) => void): void {
  render(<DiscoveryDefinitionForm onSubmit={submitToService} onCancel={vi.fn()} showAdHocAction={!!adHoc} onAdHocRun={adHoc} />);
  fireEvent.click(screen.getByRole('button', { name: 'SSH' }));
  type(/^name/i, 'web hosts');
  type(/target hosts/i, 'host1.example.com\n192.0.2.10');
  if (password !== undefined) {
    type(/^password/i, password);
  }
  type(/credential name/i, 'ssh-web');
  type(/username/i, 'deploy');
}

// L1: the onSubmit data itself (not only the wire body) carries the credential id, no credentials key at any depth, no marker.
function expectCleanSubmit(): void {
  expect(submitToService).toHaveBeenCalledTimes(1);
  const [data] = submitToService.mock.calls[0];
  expect(data.credentialId).toBe('cred-1');
  const deep = inspect(data, { depth: null });
  expect(deep).not.toMatch(/\bcredentials\b/);
  expect(deep).not.toContain(MARKER);
}

describe('HAP-774 S7 SSH discovery form', () => {
  it('(a) password path creates ssh_password with the port and submits only credential_id plus host-only targets', async () => {
    renderSsh(`${MARKER}-pw`);
    type(/port/i, '2222');
    fireEvent.click(screen.getByRole('button', { name: /create definition/i }));

    await waitFor(() => expect(posted('/discovery/definitions')).toBeDefined());
    expect(posted('/credentials')).toEqual({
      name: 'ssh-web', protocol: 'ssh_password', scope: 'ssh',
      credentials: { username: 'deploy', password: `${MARKER}-pw`, port: 2222 },
    });
    const body = posted('/discovery/definitions');
    expect(body?.credential_id).toBe('cred-1');
    expect(body?.config).toEqual({ targets: ['host1.example.com', '192.0.2.10'] });
    expect(JSON.stringify(body)).not.toContain(MARKER);
    expect(JSON.stringify(body)).not.toContain('credentials');
    expectCleanSubmit();
  });

  it('(b) private-key path creates ssh_key with the PEM text as material', async () => {
    renderSsh();
    fireEvent.click(screen.getByRole('button', { name: /private key \(pem\)/i }));
    type(/private key \(pem text\)/i, PEM);
    fireEvent.click(screen.getByRole('button', { name: /create definition/i }));

    await waitFor(() => expect(posted('/discovery/definitions')).toBeDefined());
    expect(posted('/credentials')).toMatchObject({ protocol: 'ssh_key', credentials: { username: 'deploy', private_key: PEM } });
    expect(posted('/credentials')?.credentials).not.toHaveProperty('password');
    expect(JSON.stringify(posted('/discovery/definitions'))).not.toContain(MARKER);
    expectCleanSubmit();
  });

  it('(c) error path: a failed credential save shows a fixed message, submits nothing and logs nothing', async () => {
    // The rejected request body carries the marker under a neutral field name, as an axios error would.
    request.post.mockRejectedValue(Object.assign(new Error('Request failed'), { config: { data: JSON.stringify({ note: MARKER }) } }));
    renderSsh(`${MARKER}-pw`);
    fireEvent.click(screen.getByRole('button', { name: /create definition/i }));

    expect(await screen.findByText('Failed to save the SSH credential')).toBeInTheDocument();
    expect(submitToService).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(MARKER);
  });

  it('(d) nmap has no ports field and its payload has no ports', async () => {
    render(<DiscoveryDefinitionForm onSubmit={submitToService} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText(/port range/i)).toBeNull();
    type(/^name/i, 'lan');
    type(/target ip ranges/i, '192.0.2.0/24');
    fireEvent.click(screen.getByRole('button', { name: /create definition/i }));

    await waitFor(() => expect(posted('/discovery/definitions')).toBeDefined());
    expect(JSON.stringify(posted('/discovery/definitions')?.config)).not.toContain('ports');
    expect(posted('/discovery/definitions')?.credential_id).toBeUndefined();
  });

  it.each(['ACTIVE-DIRECTORY', 'SNMP'])('(e) %s renders unsupported, collects no secret and submits nothing', (name) => {
    const { container } = render(<DiscoveryDefinitionForm onSubmit={submitToService} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name }));
    expect(screen.getByText(/discovery is unsupported/i)).toBeInTheDocument();
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(screen.queryByLabelText(/username|community|private key|credential/i)).toBeNull();
    type(/^name/i, 'directory');
    fireEvent.click(screen.getByRole('button', { name: /create definition/i }));
    expect(submitToService).not.toHaveBeenCalled();
    expect(request.post).not.toHaveBeenCalled();
  });

  it('(f) no web-ui discovery source writes credentials into config or logs from the forms', () => {
    const root = join(__dirname, '../../');
    const files = [
      ...readdirSync(`${root}components/discovery`).filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'))
        .map((f) => `components/discovery/${f}`),
      'services/discovery.service.ts', 'hooks/useDiscovery.ts',
    ];
    for (const file of files) {
      const source = readFileSync(`${root}${file}`, 'utf8');
      expect(source, file).not.toMatch(/updateConfig\(\s*['"]credentials['"]|config\.credentials|credentials:\s*config/);
    }
    for (const file of ['components/discovery/DiscoveryConfigForm.tsx', 'components/discovery/DiscoveryDefinitionForm.tsx', 'services/discovery.service.ts']) {
      expect(readFileSync(`${root}${file}`, 'utf8'), file).not.toMatch(/console\.\w+\(/);
    }
  });

  it('(g) Run Once is disabled while creating a new SSH credential and sends nothing', () => {
    const onAdHocRun = vi.fn();
    renderSsh(`${MARKER}-pw`, onAdHocRun);
    const runOnce = screen.getByRole('button', { name: /run once/i });
    expect(runOnce).toBeDisabled();
    expect(screen.getByText('Save the credential first to run once')).toBeInTheDocument();
    fireEvent.click(runOnce);
    expect(onAdHocRun).not.toHaveBeenCalled();
    expect(request.post).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(MARKER);
  });

  it('(h) Run Once stays enabled with an existing SSH credential', () => {
    saved.push({ id: 'cred-9', name: 'ops', protocol: 'ssh_key' });
    const onAdHocRun = vi.fn();
    renderSsh(undefined, onAdHocRun);
    fireEvent.click(screen.getByRole('button', { name: 'ops' }));
    fireEvent.click(screen.getByRole('button', { name: /run once/i }));
    expect(onAdHocRun).toHaveBeenCalledWith(expect.objectContaining({ credentialId: 'cred-9' }));
    expect(screen.queryByText('Save the credential first to run once')).toBeNull();
  });

  it.each([['0', false], ['1', true], ['65535', true], ['65536', false]])('(i) port %s accepted: %s', async (port, ok) => {
    renderSsh(`${MARKER}-pw`);
    type(/port/i, port);
    fireEvent.click(screen.getByRole('button', { name: /create definition/i }));
    if (ok) {
      await waitFor(() => expect(posted('/discovery/definitions')).toBeDefined());
      expect(posted('/credentials')?.credentials?.port).toBe(Number(port));
    } else {
      expect(await screen.findByText('Port must be a whole number from 1 to 65535')).toBeInTheDocument();
      expect(request.post).not.toHaveBeenCalled();
    }
  });
});
