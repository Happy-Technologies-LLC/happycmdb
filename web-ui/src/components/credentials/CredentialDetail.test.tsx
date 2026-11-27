// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// The credential detail: write controls follow the role, secrets stay masked, and an absent figure is never rendered as a value.
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { domLeaks, secretMarker } from '@/tests/utils/secretDom';

const auth = vi.hoisted(() => ({ role: 'viewer' }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));

import { CredentialDetail } from './CredentialDetail';

afterEach(cleanup);

const credential = (protocol: string, credentials: Record<string, unknown>) =>
  ({
    id: 'c1', name: 'prod-cred', protocol, scope: 'universal', credentials, tags: ['prod'], affinity: { priority: 5 },
    created_by: 'alice', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
  }) as never;

const show = (props: Partial<ComponentProps<typeof CredentialDetail>>) =>
  render(<CredentialDetail credential={credential('aws_iam', { access_key_id: 'AKIA-visible', region: 'us-east-1' })} onEdit={vi.fn()} onDelete={vi.fn()} {...props} />);

describe('CredentialDetail write controls by role', () => {
  it('a viewer sees the credential and no test, edit or delete', () => {
    auth.role = 'viewer';
    show({ onTest: vi.fn() });
    expect(screen.getByText('prod-cred')).toBeInTheDocument();
    for (const name of [/^test$/i, /^edit$/i, /^delete$/i]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('an operator sees test, edit and delete, and each acts', () => {
    auth.role = 'operator';
    const [onTest, onEdit, onDelete] = [vi.fn(), vi.fn(), vi.fn()];
    show({ onTest, onEdit, onDelete });
    fireEvent.click(screen.getByRole('button', { name: /^test$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect([onTest, onEdit, onDelete].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  });
});

describe('CredentialDetail figures', () => {
  it('an unreported usage count reads "-", a reported 0 and 1 read as such', () => {
    show({});
    expect(screen.queryByText(/used by/i)).not.toBeInTheDocument();
    expect(screen.getByText('Usage').nextElementSibling).toHaveTextContent(/^-$/);
    cleanup();
    show({ usageCount: 0 });
    expect(screen.getByText('Usage').nextElementSibling).toHaveTextContent('Used by 0 discovery definitions');
    cleanup();
    show({ usageCount: 1 });
    expect(screen.getByText('Usage').nextElementSibling).toHaveTextContent('Used by 1 discovery definition');
    expect(screen.getByText('Usage').nextElementSibling).not.toHaveTextContent('definitions');
  });

  it('a field the credential does not hold is not listed, and a bad timestamp is not shown as a date', () => {
    render(
      <CredentialDetail
        credential={Object.assign(credential('azure_sp', { client_id: 'cid', tenant_id: 'tid' }), { updated_at: undefined })}
        onEdit={vi.fn()} onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText('Client ID')).toBeInTheDocument();
    expect(screen.queryByText('Subscription ID')).not.toBeInTheDocument();
    expect(screen.queryByText('Last updated')).not.toBeInTheDocument();
    expect(screen.queryByText(/invalid date/i)).not.toBeInTheDocument();
  });
});

describe('CredentialDetail secrets', () => {
  it('shows secret values masked, reveals only the partial identifier on request, and never writes a secret to the DOM', () => {
    const secret = secretMarker('secret-key');
    const password = secretMarker('password');
    const view = (protocol: string, credentials: Record<string, unknown>) =>
      render(<CredentialDetail credential={credential(protocol, credentials)} onEdit={vi.fn()} onDelete={vi.fn()} />);

    view('aws_iam', { access_key_id: 'AKIA-visible', secret_access_key: secret });
    const value = (label: string) => screen.getByText(label).nextElementSibling!;
    expect(value('Access Key ID')).toHaveTextContent('••••••••••••');
    expect(screen.queryByText('AKIA-visible')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show partial values/i }));
    expect(value('Access Key ID')).toHaveTextContent('AKIA-visible');
    expect(value('Secret Access Key')).toHaveTextContent('••••••••••••');
    expect(domLeaks(secret)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /hide partial values/i }));
    expect(value('Access Key ID')).toHaveTextContent('••••••••••••');
    cleanup();

    view('ssh_password', { username: 'svc', password });
    fireEvent.click(screen.getByRole('button', { name: /show partial values/i }));
    expect(screen.getByText('svc')).toBeInTheDocument();
    expect(screen.getByText('Password').nextElementSibling).toHaveTextContent('••••••••••••');
    expect(domLeaks(password)).toEqual([]);
  });
});
