// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1893: connector secrets (schema type "password") live in the input value property only, never in the
// DOM tree; fields the schema does not mark as secret stay ordinary text inputs.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { domLeaks, secretMarker } from '@/tests/utils/secretDom';

const { apiClient } = vi.hoisted(() => ({ apiClient: { get: vi.fn() } }));
vi.mock('@/lib/api-client', () => ({ apiClient }));
vi.mock('@/hooks/useCredentials', () => ({
  useCredentials: () => ({ credentials: [], loading: false, error: null, loadCredentials: vi.fn() }),
}));

import { ConnectorConfigModal } from './ConnectorConfigModal';

const TEMPLATE = {
  type: 'secret-dom-connector',
  name: 'Secret DOM Connector',
  description: 'Used to test secret fields',
  icon: '🔌',
  config_schema: {
    host: { type: 'string', required: true, label: 'Host' },
    api_token: { type: 'password', required: true, label: 'API Token' },
    client_secret: { type: 'password', required: false, label: 'Client Secret' },
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openConnectionStep() {
  apiClient.get.mockResolvedValue({ data: { metadata: { resources: [] } } });
  render(<ConnectorConfigModal template={TEMPLATE} onClose={vi.fn()} onDeploy={vi.fn()} />);
  await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText('Connector Name *'), { target: { value: 'Instance' } });
  fireEvent.click(screen.getByRole('button', { name: /Next/i }));
  expect(screen.getByText('Connection Settings')).toBeInTheDocument();
}

describe('ConnectorConfigModal secret fields (HAP-1893)', () => {
  it('keeps every typed connector secret out of the DOM tree and in the input value property', async () => {
    await openConnectionStep();
    const typed = ['API Token *', 'Client Secret'].map((label) => {
      const marker = secretMarker('connector');
      const field = screen.getByLabelText(label) as HTMLInputElement;
      fireEvent.change(field, { target: { value: marker } });
      return { marker, field };
    });
    for (const { field } of typed) {
      fireEvent.change(field, { target: { value: `${field.value}-more` } });
    }

    for (const { marker, field } of typed) {
      expect(field.value).toBe(`${marker}-more`);
      expect(domLeaks(marker)).toEqual([]);
    }
  });

  it('masks only the schema-marked secret fields, with new-password autofill', async () => {
    await openConnectionStep();
    for (const label of ['API Token *', 'Client Secret']) {
      const field = screen.getByLabelText(label);
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveAttribute('autocomplete', 'new-password');
    }
    const host = screen.getByLabelText(/host/i);
    expect(host).toHaveAttribute('type', 'text');
    expect(host).not.toHaveAttribute('autocomplete', 'new-password');
  });

  it('leaves a non-secret field mirrored as an ordinary controlled text input', async () => {
    await openConnectionStep();
    const host = screen.getByLabelText(/host/i) as HTMLInputElement;
    fireEvent.change(host, { target: { value: 'connector.example.com' } });
    expect(host.value).toBe('connector.example.com');
    expect(host.getAttribute('value')).toBe('connector.example.com');
  });
});
