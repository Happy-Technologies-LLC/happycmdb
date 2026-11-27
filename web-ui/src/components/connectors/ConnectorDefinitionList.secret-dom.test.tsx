// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1895: the oracle-cloud `private_key` (`format: 'textarea'`, `sensitive: true` in its shipped
// connector.json) travels connector.json -> `installed_connectors.configuration_schema` ->
// `publicInstalledConnector` (what GET /connectors/installed returns) -> ConnectorDefinitionList ->
// ConnectorConfigModal, and must render through SecretTextarea: never in the DOM tree, still deployed.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { domLeaks, secretMarker } from '@/tests/utils/secretDom';
import { publicInstalledConnector } from '../../../../packages/api-server/src/services/public-installed-connector';

const { apiClient, permission } = vi.hoisted(() => ({
  apiClient: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  permission: { write: true },
}));
vi.mock('@/lib/api-client', () => ({ apiClient }));
vi.mock('@/hooks/useCredentials', () => ({
  useCredentials: () => ({ credentials: [], loading: false, error: null, loadCredentials: vi.fn() }),
}));
vi.mock('@happy-technologies/design-system', async (importActual) => ({
  ...(await importActual<typeof import('@happy-technologies/design-system')>()),
  Icon: () => null,
}));

import { ConnectorDefinitionList } from './ConnectorDefinitionList';
// These screens gate their write controls on the signed-in role (HAP-1252 S1); this test is about the writes, so the user may write.
vi.mock('@/hooks/usePermission', () => ({ usePermission: () => permission.write }));

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
  permission.write = true;
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

// HAP-1922: the list on the design system. Loading, empty, a retryable error and a refused read each get their own
// state; a viewer sees the rows but no write control.
describe('ConnectorDefinitionList states and write gating (HAP-1922)', () => {
  const config = {
    id: 'cfg-1', name: 'Prod ServiceNow', connector_type: 'servicenow', enabled: true,
    schedule_enabled: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  };
  const mockReads = (configs: () => Promise<unknown>) =>
    apiClient.get.mockImplementation(async (url: string) => {
      if (url === '/connector-configs') return configs();
      if (url === '/connectors/installed') return { data: [] };
      throw new Error('Unexpected test endpoint');
    });
  const renderList = () =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter><ConnectorDefinitionList /></MemoryRouter>
      </QueryClientProvider>
    );

  it('does not read as empty while the definitions are loading', async () => {
    mockReads(() => new Promise(() => {}));
    renderList();
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/connector-configs', expect.anything()));
    expect(screen.queryByText(/No connectors deployed yet/)).toBeNull();
    expect(screen.queryByText('Could not load connector definitions')).toBeNull();
  });

  it('says so when nothing is deployed', async () => {
    mockReads(async () => ({ data: [] }));
    renderList();
    expect(await screen.findByText(/No connectors deployed yet/)).toBeInTheDocument();
    expect(screen.getByText('0 of 0 connectors')).toBeInTheDocument();
  });

  it('shows a failed read with a retry that loads the rows', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    mockReads(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Request failed with status code 500');
      return { data: [config] };
    });
    renderList();

    expect(await screen.findByText('Could not load connector definitions')).toBeInTheDocument();
    expect(screen.queryByText(/No connectors deployed yet/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Prod ServiceNow')).toBeInTheDocument();
    expect(screen.queryByText('Could not load connector definitions')).toBeNull();
  });

  it("shows the server's own reason when the read is refused", async () => {
    mockReads(async () => {
      throw { response: { status: 403, data: { _message: "Permission 'read' required" } } };
    });
    renderList();

    expect(await screen.findByText('No access to connector definitions')).toBeInTheDocument();
    expect(screen.getByText("Permission 'read' required")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows a viewer the rows and no write control', async () => {
    permission.write = false;
    mockReads(async () => ({ data: [config] }));
    renderList();

    expect(await screen.findByText('Prod ServiceNow')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install Connector' })).toBeNull();
    for (const name of ['Run Now', 'Edit', 'Delete']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('gives a writer the row actions, and Delete asks before it sends', async () => {
    const user = userEvent.setup();
    mockReads(async () => ({ data: [config] }));
    apiClient.delete.mockResolvedValue({});
    renderList();

    expect(await screen.findByRole('button', { name: 'Install Connector' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(apiClient.delete).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Delete Connector' });
    expect(dialog).toHaveTextContent('Are you sure you want to delete "Prod ServiceNow"?');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(apiClient.delete).toHaveBeenCalledWith('/connector-configs/cfg-1'));
  });
});

// HAP-1922 (review B2): the Install dialog's own states. A failed or refused installed-connector read is shown as such
// (never as an empty catalogue), and a search with no hit says so.
describe('ConnectorDefinitionList Install dialog states (HAP-1922)', () => {
  const mockInstalled = (installed: () => Promise<unknown>) =>
    apiClient.get.mockImplementation(async (url: string) => {
      if (url === '/connector-configs') return { data: [] };
      if (url === '/connectors/installed') return installed();
      throw new Error('Unexpected test endpoint');
    });
  const openInstall = async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter><ConnectorDefinitionList /></MemoryRouter>
      </QueryClientProvider>
    );
    await user.click(await screen.findByRole('button', { name: 'Install Connector' }));
    return { user, dialog: await screen.findByRole('dialog', { name: 'Install Connector' }) };
  };

  it('shows a failed installed-connector read with a retry, not an empty catalogue', async () => {
    let attempts = 0;
    mockInstalled(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Request failed with status code 500');
      return { data: [] };
    });
    const { user, dialog } = await openInstall();

    expect(await within(dialog).findByText('Could not load installed connectors')).toBeInTheDocument();
    expect(within(dialog).queryByText('No connectors match the current filters.')).toBeNull();
    const before = attempts;
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(attempts).toBeGreaterThan(before));
    await waitFor(() => expect(within(dialog).queryByText('Could not load installed connectors')).toBeNull());
  });

  it('shows a refused installed-connector read as not permitted, with no retry', async () => {
    mockInstalled(async () => {
      throw { response: { status: 403, data: { _message: "Permission 'read' required" } } };
    });
    const { dialog } = await openInstall();

    expect(await within(dialog).findByText('No access to installed connectors')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(within(dialog).queryByText('No connectors match the current filters.')).toBeNull();
  });

  it('says so when the search matches no connector', async () => {
    mockInstalled(async () => ({ data: [] }));
    const { user, dialog } = await openInstall();

    await user.type(within(dialog).getByLabelText('Search available connectors'), 'zzz-no-such-connector');
    expect(await within(dialog).findByText('No connectors match the current filters.')).toBeInTheDocument();
  });
});
