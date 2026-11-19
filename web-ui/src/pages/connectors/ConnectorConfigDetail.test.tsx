// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ConnectorConfigDetail from './ConnectorConfigDetail';

const auth = vi.hoisted(() => ({ role: 'admin' }));
vi.mock('@contexts/AuthContext', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));

const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/contexts/ToastContext', () => ({ useToast: () => ({ showToast }) }));

const svc = vi.hoisted(() => ({
  getConnectorConfiguration: vi.fn(),
  runConnector: vi.fn(),
  enableConnectorConfiguration: vi.fn(),
  disableConnectorConfiguration: vi.fn(),
  deleteConnectorConfiguration: vi.fn(),
}));
vi.mock('@/services/connector.service', () => ({ connectorService: svc }));

vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) => (
      <div style={{ width: 600, height: 300 }}>{children}</div>
    ),
  };
});

const run = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  configId: 'cfg-1',
  connectorType: 'aws',
  configName: 'Prod AWS',
  resourceId: 'ec2-instances',
  startedAt: '2026-11-01T10:00:00Z',
  status: 'COMPLETED',
  recordsExtracted: 42,
  recordsTransformed: 42,
  recordsLoaded: 40,
  recordsFailed: 2,
  durationMs: 2500,
  triggeredBy: 'manual',
  ...over,
});

const makeConfig = (over: Record<string, unknown> = {}) => ({
  id: 'cfg-1',
  name: 'Prod AWS',
  description: 'Production account',
  connectorType: 'aws',
  enabled: true,
  schedule: '0 * * * *',
  scheduleEnabled: true,
  enabledResources: ['ec2-instances'],
  maxRetries: 3,
  retryDelaySeconds: 30,
  continueOnError: true,
  notificationOnSuccess: false,
  notificationOnFailure: true,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  connector: {
    id: 'c',
    connectorType: 'aws',
    name: 'Amazon Web Services',
    installedVersion: '2.1.0',
    resources: [
      { id: 'ec2-instances', name: 'EC2 Instances', ciType: 'virtual-machine', operations: ['read'], enabledByDefault: true },
    ],
  },
  runs: [run()],
  metrics: { totalRuns: 10, successfulRuns: 9, failedRuns: 1, successRate: 90, avgDurationMs: 1, totalRecordsProcessed: 1, resourceMetrics: [] },
  ...over,
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/connectors/configs/cfg-1']}>
      <Routes>
        <Route path="/connectors/configs/:id" element={<ConnectorConfigDetail />} />
        <Route path="/connectors/installed" element={<div>Installed connectors page</div>} />
        <Route path="/connectors/configs/:id/edit" element={<div>Edit page</div>} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  auth.role = 'admin';
  Object.values(svc).forEach((f) => f.mockReset());
  showToast.mockReset();
  svc.getConnectorConfiguration.mockResolvedValue(makeConfig());
  svc.runConnector.mockResolvedValue({});
  svc.enableConnectorConfiguration.mockResolvedValue({});
  svc.disableConnectorConfiguration.mockResolvedValue({});
  svc.deleteConnectorConfiguration.mockResolvedValue({ success: true });
});
afterEach(() => cleanup());

const loaded = () => screen.findByRole('heading', { level: 1, name: 'Prod AWS' });

describe('ConnectorConfigDetail states', () => {
  it('shows the loading state, not the data, while the read is pending', async () => {
    svc.getConnectorConfiguration.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(await screen.findByText('Loading connector configuration…')).toBeInTheDocument();
    expect(screen.queryByText('Prod AWS')).not.toBeInTheDocument();
  });

  it('renders the name, tabs and status cards', async () => {
    renderPage();
    await loaded();
    for (const name of ['Overview', 'Resources', 'Run History', 'Metrics']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
    expect(screen.getByText('Production account')).toBeInTheDocument();
    expect(within(screen.getAllByText('Status')[0].parentElement as HTMLElement).getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('0 * * * *')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.getByText('9 of 10 runs')).toBeInTheDocument();
  });

  it('a failed read shows the error with a retry that re-reads and renders the data', async () => {
    svc.getConnectorConfiguration.mockRejectedValueOnce(new Error('boom'));
    renderPage();
    expect(await screen.findByText('Could not load connector configuration')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(showToast).toHaveBeenCalledWith('Failed to load connector configuration', 'error');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await loaded();
    expect(svc.getConnectorConfiguration).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Could not load connector configuration')).not.toBeInTheDocument();
  });

  it('a refused read (Apollo network error 403) shows the server reason, no retry, no spinner, no toast', async () => {
    svc.getConnectorConfiguration.mockRejectedValueOnce(
      Object.assign(new Error('Response not successful: Received status code 403'), {
        networkError: { statusCode: 403, result: { _message: "Permission 'read' required" } },
      })
    );
    renderPage();
    expect(await screen.findByText('Not permitted')).toBeInTheDocument();
    expect(screen.getByText("Permission 'read' required")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a FORBIDDEN GraphQL error and an axios 403 are refusals too', async () => {
    svc.getConnectorConfiguration.mockRejectedValueOnce(
      Object.assign(new Error('x'), { graphQLErrors: [{ message: 'Not allowed here', extensions: { code: 'FORBIDDEN' } }] })
    );
    renderPage();
    expect(await screen.findByText('Not allowed here')).toBeInTheDocument();
    cleanup();
    svc.getConnectorConfiguration.mockRejectedValueOnce(
      Object.assign(new Error('x'), { response: { status: 403, data: { message: 'Axios says no' } } })
    );
    renderPage();
    expect(await screen.findByText('Axios says no')).toBeInTheDocument();
  });

  it('a null result says the configuration was not found, with a Back button, not a spinner', async () => {
    svc.getConnectorConfiguration.mockResolvedValue(null);
    renderPage();
    expect(await screen.findByText('Connector configuration not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('without metrics the success rate is a hyphen, never 0%', async () => {
    svc.getConnectorConfiguration.mockResolvedValue(makeConfig({ metrics: null }));
    renderPage();
    await loaded();
    const card = screen.getByText('Success Rate').parentElement as HTMLElement;
    expect(within(card).getByText('-')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.queryByText(/of \d+ runs/)).not.toBeInTheDocument();
  });
});

describe('ConnectorConfigDetail write controls by role', () => {
  it('a viewer sees neither Run Now nor the actions menu', async () => {
    auth.role = 'viewer';
    renderPage();
    await loaded();
    expect(screen.queryByRole('button', { name: /run now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
  });

  it.each(['operator', 'admin'])('an %s sees Run Now and the actions menu', async (role) => {
    auth.role = role;
    renderPage();
    await loaded();
    expect(screen.getByRole('button', { name: 'Run Now' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /more actions/i })).toBeInTheDocument();
  });

  it('Run Now is disabled while the configuration is disabled', async () => {
    svc.getConnectorConfiguration.mockResolvedValue(makeConfig({ enabled: false }));
    renderPage();
    await loaded();
    expect(screen.getByRole('button', { name: 'Run Now' })).toBeDisabled();
  });
});

describe('ConnectorConfigDetail actions', () => {
  it('Run Now runs the connector and reloads the configuration', async () => {
    renderPage();
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: 'Run Now' }));
    await waitFor(() => expect(svc.runConnector).toHaveBeenCalledWith('cfg-1'));
    await waitFor(() => expect(svc.getConnectorConfiguration).toHaveBeenCalledTimes(2));
    expect(showToast).toHaveBeenCalledWith('Prod AWS is now running', 'success');
    await loaded();
  });

  it('the menu disables an enabled configuration', async () => {
    renderPage();
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Disable' }));
    await waitFor(() => expect(svc.disableConnectorConfiguration).toHaveBeenCalledWith('cfg-1'));
    expect(svc.enableConnectorConfiguration).not.toHaveBeenCalled();
  });

  it('the menu enables a disabled configuration', async () => {
    svc.getConnectorConfiguration.mockResolvedValue(makeConfig({ enabled: false }));
    renderPage();
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Enable' }));
    await waitFor(() => expect(svc.enableConnectorConfiguration).toHaveBeenCalledWith('cfg-1'));
    expect(svc.disableConnectorConfiguration).not.toHaveBeenCalled();
  });

  it('the menu opens the edit page', async () => {
    renderPage();
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit Configuration' }));
    expect(await screen.findByText('Edit page')).toBeInTheDocument();
  });

  it('Delete asks to confirm, then deletes and leaves for the installed list', async () => {
    renderPage();
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete Configuration')).toBeInTheDocument();
    expect(svc.deleteConnectorConfiguration).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(svc.deleteConnectorConfiguration).toHaveBeenCalledWith('cfg-1'));
    expect(await screen.findByText('Installed connectors page')).toBeInTheDocument();
  });

  it('cancelling the delete dialog deletes nothing', async () => {
    renderPage();
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(svc.deleteConnectorConfiguration).not.toHaveBeenCalled();
  });

  it('a refused delete shows the failure toast and stays on the page', async () => {
    svc.deleteConnectorConfiguration.mockResolvedValue({ success: false });
    renderPage();
    await loaded();
    await userEvent.click(screen.getByRole('button', { name: /more actions/i }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Failed to delete configuration', 'error'));
    expect(screen.queryByText('Installed connectors page')).not.toBeInTheDocument();
  });
});

describe('ConnectorConfigDetail tabs', () => {
  it('Run History says No runs yet when there are none', async () => {
    svc.getConnectorConfiguration.mockResolvedValue(makeConfig({ runs: [] }));
    renderPage();
    await loaded();
    await userEvent.click(screen.getByRole('tab', { name: 'Run History' }));
    expect(screen.getByText('No runs yet')).toBeVisible();
  });

  it('Run History lists each run with status, resource and record counts', async () => {
    svc.getConnectorConfiguration.mockResolvedValue(
      makeConfig({ runs: [run(), run({ id: 'r2', status: 'FAILED', resourceId: undefined, recordsExtracted: 7, recordsLoaded: 0, durationMs: undefined })] })
    );
    renderPage();
    await loaded();
    await userEvent.click(screen.getByRole('tab', { name: 'Run History' }));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText('FAILED')).toBeInTheDocument();
    expect(within(table).getByText('ec2-instances')).toBeInTheDocument();
    expect(within(table).getByText('42 extracted')).toBeInTheDocument();
    expect(within(table).getByText('40 loaded')).toBeInTheDocument();
    expect(within(table).getByText('All')).toBeInTheDocument();
    expect(within(table).getByText('2.5s')).toBeInTheDocument();
  });

  it('Resources lists the enabled resources', async () => {
    renderPage();
    await loaded();
    await userEvent.click(screen.getByRole('tab', { name: 'Resources' }));
    expect(screen.getByText('EC2 Instances')).toBeVisible();
    expect(screen.getByText('virtual-machine')).toBeVisible();
  });

  it('Metrics shows the trend chart and per-resource metrics', async () => {
    svc.getConnectorConfiguration.mockResolvedValue(
      makeConfig({
        metrics: {
          totalRuns: 1, successfulRuns: 1, failedRuns: 0, successRate: 100, avgDurationMs: 1, totalRecordsProcessed: 1,
          resourceMetrics: [{ resourceId: 'ec2-instances', totalRecordsExtracted: 1234, totalRecordsLoaded: 1, successRate: 98.76, avgExtractionTimeMs: 1000, avgTransformationTimeMs: 500, avgLoadTimeMs: 500 }],
        },
      })
    );
    renderPage();
    await loaded();
    await userEvent.click(screen.getByRole('tab', { name: 'Metrics' }));
    expect(screen.getByText('Performance Trends')).toBeVisible();
    expect(screen.getByText('1,234')).toBeVisible();
    expect(screen.getByText('98.8%')).toBeVisible();
    expect(screen.getByText('2.0s')).toBeVisible();
  });
});
