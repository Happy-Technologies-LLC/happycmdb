// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1213: typed credential secrets live in the input's value property only, never in the DOM tree.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { domLeaks, secretMarker } from '@/tests/utils/secretDom';

vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('@happy-technologies/design-system', () => ({ Icon: () => null, Eyebrow: () => null }));

import { CredentialForm } from './CredentialForm';

afterEach(cleanup);

// Every secret field the form renders, per protocol, by element id. gcp_sa is one JSON textarea.
const SECRET_FIELDS: Record<string, string[]> = {
  aws_iam: ['access_key_id', 'secret_access_key', 'session_token'],
  azure_sp: ['client_secret'],
  api_key: ['key'],
  bearer: ['token'],
  basic: ['password'],
  snmp_v2c: ['community_string'],
  snmp_v3: ['auth_password', 'priv_password'],
  oauth2: ['client_secret'],
  ssh_key: ['private_key', 'passphrase'],
  ssh_password: ['password'],
  certificate: ['private_key', 'passphrase'],
  kerberos: ['keytab', 'password'],
  winrm: ['password'],
};

const renderProtocol = (protocol: string) =>
  render(
    <CredentialForm
      credential={{ id: 'c1', name: 'n', protocol, scope: 'universal', credentials: {}, tags: [] } as never}
      onSubmit={vi.fn()}
      onCancel={vi.fn()}
    />
  );

const field = (id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no #${id} rendered`);
  return el as HTMLInputElement | HTMLTextAreaElement;
};

describe('CredentialForm secret fields (HAP-1213)', () => {
  it.each(Object.entries(SECRET_FIELDS))(
    '%s: typed secrets stay out of the DOM tree and in the input value property',
    (protocol, ids) => {
      renderProtocol(protocol);
      const typed = ids.map((id) => {
        const marker = secretMarker(id);
        fireEvent.change(field(id), { target: { value: marker } });
        return { id, marker };
      });
      // A second edit takes the update path as well as the first commit.
      for (const { id, marker } of typed) {
        fireEvent.change(field(id), { target: { value: `${marker}-more` } });
      }

      for (const { id, marker } of typed) {
        expect(field(id).value).toBe(`${marker}-more`);
        expect(domLeaks(marker)).toEqual([]);
      }
    }
  );

  it('gcp_sa: the pasted service-account JSON stays out of the DOM tree', () => {
    renderProtocol('gcp_sa');
    const marker = secretMarker('gcp');
    fireEvent.change(field('service_account_json'), {
      target: { value: JSON.stringify({ type: 'service_account', private_key: marker }) },
    });
    expect(field('service_account_json').value).toContain(marker);
    expect(domLeaks(marker)).toEqual([]);
  });

  it('a revealed secret (type=text) is still not mirrored, and masks again when hidden', () => {
    renderProtocol('basic');
    const marker = secretMarker('reveal');
    const password = field('password');
    fireEvent.change(password, { target: { value: marker } });
    const toggle = password.nextElementSibling as HTMLButtonElement;

    fireEvent.click(toggle);
    expect(password.type).toBe('text');
    expect(password.value).toBe(marker);
    expect(domLeaks(marker)).toEqual([]);

    fireEvent.click(toggle);
    expect(password.type).toBe('password');
    expect(password.value).toBe(marker);
    expect(domLeaks(marker)).toEqual([]);
  });

  it('every single-line secret field is a password input with autofill off', () => {
    for (const [protocol, ids] of Object.entries(SECRET_FIELDS)) {
      const { unmount } = renderProtocol(protocol);
      for (const id of ids) {
        const el = field(id);
        if (el instanceof HTMLTextAreaElement) {
          expect(el.autocomplete).toBe('off');
        } else {
          expect([id, el.type, el.autocomplete]).toEqual([id, 'password', 'new-password']);
        }
      }
      unmount();
    }
  });
});
