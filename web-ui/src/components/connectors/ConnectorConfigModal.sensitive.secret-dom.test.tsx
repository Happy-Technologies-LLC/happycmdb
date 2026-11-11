// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1895: a connector field the schema marks `sensitive` (single-line or `format: 'textarea'`) or
// `format: 'password'` goes through SecretInput / SecretTextarea: the typed secret lives in the element's
// `.value` property, never in the DOM tree, and still reaches the deploy payload unchanged.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { domLeaks, secretMarker } from '@/tests/utils/secretDom';

const { apiClient } = vi.hoisted(() => ({ apiClient: { get: vi.fn() } }));
vi.mock('@/lib/api-client', () => ({ apiClient }));
vi.mock('@/hooks/useCredentials', () => ({
  useCredentials: () => ({ credentials: [], loading: false, error: null, loadCredentials: vi.fn() }),
}));
vi.mock('@happy-technologies/design-system', () => ({ Icon: () => null }));

import { ConnectorConfigModal } from './ConnectorConfigModal';

const TEMPLATE = {
  type: 'sensitive-fields-connector',
  name: 'Sensitive Fields Connector',
  description: 'Used to test sensitive schema fields',
  icon: '🔌',
  config_schema: {
    host: { type: 'string', required: false, label: 'Host' },
    vendor_token: { type: 'string', sensitive: true, required: false, label: 'Vendor Token' },
    signing_key: { type: 'string', format: 'textarea', sensitive: true, required: false, label: 'Signing Key' },
    legacy_password: { type: 'string', format: 'password', required: false, label: 'Legacy Password' },
    notes: { type: 'textarea', required: false, label: 'Notes' },
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openConnectionStep() {
  apiClient.get.mockResolvedValue({ data: { metadata: { resources: [] } } });
  const onDeploy = vi.fn();
  render(<ConnectorConfigModal template={TEMPLATE} onClose={vi.fn()} onDeploy={onDeploy} />);
  await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Connector Name *'), { target: { value: 'Instance' } });
  fireEvent.click(screen.getByRole('button', { name: /Next/i }));
  expect(screen.getByText('Connection Settings')).toBeInTheDocument();
  return onDeploy;
}

async function deploy(onDeploy: ReturnType<typeof vi.fn>) {
  fireEvent.click(screen.getByRole('button', { name: /Next/i }));
  await waitFor(() => expect(screen.getByText('Field Mapping by Resource')).toBeInTheDocument());
  await waitFor(() => expect(screen.queryByText('Loading connector resources...')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Deploy Connector' }));
  expect(onDeploy).toHaveBeenCalledTimes(1);
  return onDeploy.mock.calls[0][0];
}

describe('ConnectorConfigModal sensitive schema fields (HAP-1895)', () => {
  it('keeps a sensitive single-line field and a format:password field out of the DOM, in .value and the payload', async () => {
    const onDeploy = await openConnectionStep();
    const typed = [
      { label: 'Vendor Token', key: 'vendor_token' },
      { label: 'Legacy Password', key: 'legacy_password' },
    ].map(({ label, key }) => {
      const marker = secretMarker(key);
      const field = screen.getByLabelText(label) as HTMLInputElement;
      fireEvent.change(field, { target: { value: marker } });
      return { marker, key, field };
    });

    for (const { marker, field } of typed) {
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveAttribute('autocomplete', 'new-password');
      expect(field.value).toBe(marker);
      expect(domLeaks(marker)).toEqual([]);
    }
    const payload = await deploy(onDeploy);
    for (const { marker, key } of typed) {
      expect(payload.connection[key]).toBe(marker);
    }
  });

  it('keeps a sensitive multi-line field out of the DOM, in .value and the payload', async () => {
    const onDeploy = await openConnectionStep();
    const marker = secretMarker('pem');
    const pem = `-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----`;
    const field = screen.getByLabelText('Signing Key') as HTMLTextAreaElement;
    expect(field.tagName).toBe('TEXTAREA');
    fireEvent.change(field, { target: { value: pem } });

    expect(field.value).toBe(pem);
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(field).toHaveAttribute('spellcheck', 'false');
    expect(domLeaks(marker)).toEqual([]);

    const payload = await deploy(onDeploy);
    expect(payload.connection.signing_key).toBe(pem);
  });

  it('leaves non-sensitive fields as ordinary controlled fields with the same payload', async () => {
    const onDeploy = await openConnectionStep();
    const host = screen.getByLabelText('Host') as HTMLInputElement;
    const notes = screen.getByLabelText('Notes') as HTMLTextAreaElement;
    fireEvent.change(host, { target: { value: 'connector.example.com' } });
    fireEvent.change(notes, { target: { value: 'plain note' } });

    expect(host).toHaveAttribute('type', 'text');
    expect(host.getAttribute('value')).toBe('connector.example.com');
    expect(notes.textContent).toBe('plain note');
    const payload = await deploy(onDeploy);
    expect(payload.connection).toEqual({ host: 'connector.example.com', notes: 'plain note' });
  });
});
