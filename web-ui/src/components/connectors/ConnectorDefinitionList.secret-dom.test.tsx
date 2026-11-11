// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1895: the oracle-cloud `private_key` (`format: 'textarea'`, `sensitive: true` in its shipped
// connector.json) travels connector.json -> `installed_connectors.configuration_schema` ->
// `publicInstalledConnector` (what GET /connectors/installed returns) -> ConnectorDefinitionList ->
// ConnectorConfigModal, and must render through SecretTextarea: never in the DOM tree, still deployed.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { domLeaks, secretMarker } from '@/tests/utils/secretDom';
import { publicInstalledConnector } from '../../../../packages/api-server/src/services/public-installed-connector';

const { apiClient } = vi.hoisted(() => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/lib/api-client', () => ({ apiClient }));
vi.mock('@/hooks/useCredentials', () => ({
  useCredentials: () => ({ credentials: [], loading: false, error: null, loadCredentials: vi.fn() }),
}));
vi.mock('@happy-technologies/design-system', () => ({ Icon: () => null }));

import { ConnectorDefinitionList } from './ConnectorDefinitionList';

const manifest = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../../packages/connectors/oracle-cloud/connector.json'), 'utf-8')
);
// The row the loader stores: `configuration_schema` is the manifest's schema verbatim.
const installedRow = {
  connector_type: manifest.type, name: manifest.name, category: 'connector',
  configuration_schema: manifest.configuration_schema, resources: [],
};

beforeEach(() => {
  apiClient.get.mockImplementation(async (url: string) => {
    if (url === '/connector-configs') return { data: [] };
    if (url === '/connectors/installed') return { data: [publicInstalledConnector(installedRow)] };
    if (url === `/connectors/installed/${manifest.type}`) return { data: publicInstalledConnector(installedRow) };
    throw new Error('Unexpected test endpoint');
  });
  apiClient.post.mockResolvedValue({ data: { id: 'created' } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('oracle-cloud private_key through ConnectorDefinitionList (HAP-1895)', () => {
  it('renders as a secret textarea fed from the installed template, keeps the PEM out of the DOM, deploys it', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter><ConnectorDefinitionList /></MemoryRouter>
      </QueryClientProvider>
    );
    await user.click(screen.getByRole('button', { name: 'Install Connector' }));
    await user.click(await screen.findByRole('button', { name: 'Deploy', exact: true }));
    await user.type(screen.getByLabelText('Connector Name *'), 'OCI prod');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    const marker = secretMarker('oci-pem');
    const pem = `-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----`;
    const field = screen.getByLabelText('Private Key *') as HTMLTextAreaElement;
    expect(field.tagName).toBe('TEXTAREA');
    fireEvent.change(field, { target: { value: pem } });
    expect(field.value).toBe(pem);
    expect(domLeaks(marker)).toEqual([]);

    await user.type(screen.getByLabelText('Tenancy Ocid *'), 'ocid1.tenancy.oc1..t');
    await user.type(screen.getByLabelText('User Ocid *'), 'ocid1.user.oc1..u');
    await user.type(screen.getByLabelText('Fingerprint *'), '12:34');
    await user.type(screen.getByLabelText('Region *'), 'us-ashburn-1');
    expect(domLeaks(marker)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.queryByText('Loading connector resources...')).toBeNull());
    await user.click(screen.getAllByRole('button', { name: 'Deploy Connector' }).at(-1)!);

    await waitFor(() => expect(apiClient.post).toHaveBeenCalled());
    const [url, body] = apiClient.post.mock.calls[0];
    expect(url).toBe('/connector-configs');
    expect(body.connection).toEqual({
      tenancy_ocid: 'ocid1.tenancy.oc1..t', user_ocid: 'ocid1.user.oc1..u', fingerprint: '12:34',
      private_key: pem, region: 'us-ashburn-1',
    });
  });
});
