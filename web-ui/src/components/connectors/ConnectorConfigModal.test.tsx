// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// Final cycle-10 live-component retest. F-043: connector configuration
// wizard (loadTemplate fetches the installed connector template on mount;
// handleNext advances step or deploys on the final step; canProceed gates
// Next/Deploy per step -- step 1 requires a non-empty name).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiClient } = vi.hoisted(() => ({ apiClient: { get: vi.fn() } }));
vi.mock('@/lib/api-client', () => ({ apiClient }));

vi.mock('@/hooks/useCredentials', () => ({
  useCredentials: () => ({ credentials: [], loading: false, error: null, loadCredentials: vi.fn() }),
}));

import { ConnectorConfigModal } from './ConnectorConfigModal';

const TEMPLATE = {
  type: 'c10fc-config-connector',
  name: 'Config Test Connector',
  description: 'Used to test ConnectorConfigModal',
  icon: '🔌',
  config_schema: {
    host: { required: true, label: 'Host' },
    port: { required: false, label: 'Port' },
  },
};

function renderModal(onClose = vi.fn(), onDeploy = vi.fn()) {
  render(<ConnectorConfigModal template={TEMPLATE} onClose={onClose} onDeploy={onDeploy} />);
  return { onClose, onDeploy };
}

describe('ConnectorConfigModal (F-043)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockResolvedValue({
      data: { metadata: { resources: [{ id: 'servers', enabled_by_default: true, field_mappings: {} }] } },
    });
  });

  it('loadTemplate fetches the installed connector template on mount', async () => {
    renderModal();
    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith(`/connectors/installed/${TEMPLATE.type}`);
    });
  });

  it('step 1 requires a non-empty name before Next is enabled; typing a name enables it', async () => {
    const user = userEvent.setup();
    renderModal();
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());

    const nextButton = screen.getByRole('button', { name: /Next/i });
    expect(nextButton).toBeDisabled();

    await user.type(screen.getByLabelText('Connector Name *'), 'My Connector Instance');
    expect(nextButton).not.toBeDisabled();
  });

  it('handleNext advances through steps 1 -> 2 -> 3, then calls onDeploy on the final step', async () => {
    const user = userEvent.setup();
    const { onDeploy } = renderModal();
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());

    await user.type(screen.getByLabelText('Connector Name *'), 'My Connector Instance');
    await user.click(screen.getByRole('button', { name: /Next/i }));

    // Step 2: Connection -- required field "host" blocks Next until filled.
    expect(screen.getByText('Connection Settings')).toBeInTheDocument();
    const nextStep2 = screen.getByRole('button', { name: /Next/i });
    expect(nextStep2).toBeDisabled();

    const hostInput = screen.getByLabelText(/host/i);
    await user.type(hostInput, 'connector.example.com');
    expect(screen.getByRole('button', { name: /Next/i })).not.toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Next/i }));

    // Step 3: Field Mapping -- final step, button becomes Deploy.
    const deployButton = screen.getByRole('button', { name: /Deploy/i });
    await user.click(deployButton);

    expect(onDeploy).toHaveBeenCalledTimes(1);
    const deployedConfig = onDeploy.mock.calls[0][0];
    expect(deployedConfig.name).toBe('My Connector Instance');
    expect(deployedConfig.connection.host).toBe('connector.example.com');
  });

  it('handleBack returns from step 2 to step 1', async () => {
    const user = userEvent.setup();
    renderModal();
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());

    await user.type(screen.getByLabelText('Connector Name *'), 'My Connector Instance');
    await user.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByLabelText(/host/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Back/i }));
    expect(screen.getByLabelText('Connector Name *')).toBeInTheDocument();
  });
});

// UX-4b S8e (HAP-1922): the wizard on the design system. Its dialog is named, its fields keep their labels and
// types, and a failed resource read is shown with a retry instead of reading as "no resources".
describe('ConnectorConfigModal on the design system (HAP-1922)', () => {
  const SCHEMA_TEMPLATE = {
    ...TEMPLATE,
    config_schema: {
      host: { type: 'string', required: true, label: 'Host' },
      api_token: { type: 'string', sensitive: true, required: false, label: 'API Token' },
      region: { type: 'select', required: false, label: 'Region', options: ['us-east', 'eu-west'], default: 'us-east' },
    },
  };
  const RESOURCE = {
    id: 'servers', name: 'Servers', description: 'Server inventory', ci_type: 'server',
    enabled_by_default: true, field_mappings: {},
  };

  async function openResourceStep(template = SCHEMA_TEMPLATE) {
    const user = userEvent.setup();
    const onDeploy = vi.fn();
    render(<ConnectorConfigModal template={template} onClose={vi.fn()} onDeploy={onDeploy} />);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    await user.type(screen.getByLabelText('Connector Name *'), 'Instance');
    await user.click(screen.getByRole('button', { name: /Next/i }));
    await user.type(screen.getByLabelText('Host *'), 'h.example.com');
    await user.click(screen.getByRole('button', { name: /Next/i }));
    return { user, onDeploy };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockResolvedValue({ data: { metadata: { resources: [RESOURCE] } } });
  });

  it('names the dialog and keeps the labels and types of a sensitive and a non-sensitive field', async () => {
    const user = userEvent.setup();
    render(<ConnectorConfigModal template={SCHEMA_TEMPLATE} onClose={vi.fn()} onDeploy={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Configure Config Test Connector' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Connector Name *'), 'Instance');
    await user.click(screen.getByRole('button', { name: /Next/i }));

    expect(screen.getByLabelText('Host *')).toHaveAttribute('type', 'text');
    const token = screen.getByLabelText('API Token');
    expect(token).toHaveAttribute('type', 'password');
    expect(token).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByRole('combobox', { name: 'Region' })).toBeInTheDocument();
  });

  it('deploys the typed values and the chosen select option in the same payload shape', async () => {
    const { user, onDeploy } = await openResourceStep();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('combobox', { name: 'Region' }));
    await user.click(await screen.findByRole('option', { name: 'eu-west' }));
    await user.click(screen.getByRole('button', { name: /Next/i }));
    await screen.findByText('Servers');
    await user.click(screen.getByRole('button', { name: 'Deploy Connector' }));

    const payload = onDeploy.mock.calls[0][0];
    expect(payload).toMatchObject({
      name: 'Instance',
      type: TEMPLATE.type,
      enabled: true,
      connection: { host: 'h.example.com', region: 'eu-west' },
      enabled_resources: ['servers'],
      schedule: { enabled: false, cron_expression: '0 9 * * *' },
    });
  });

  it('shows a failed resource read with a retry, without echoing the server error', async () => {
    apiClient.get
      .mockRejectedValueOnce(new Error('upstream leaked-detail 10.0.0.7'))
      .mockResolvedValue({ data: { metadata: { resources: [RESOURCE] } } });
    const { user } = await openResourceStep();

    expect(await screen.findByText('Could not load connector resources')).toBeInTheDocument();
    expect(screen.queryByText('No resources found for this connector')).toBeNull();
    expect(document.body).not.toHaveTextContent('leaked-detail');

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Servers')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Could not load connector resources')).toBeNull();
  });

  it('shows a refused resource read as not permitted, with no retry', async () => {
    apiClient.get.mockRejectedValue({ response: { status: 403, data: { message: 'leaked-detail' } } });
    await openResourceStep();

    expect(await screen.findByText('No access to connector resources')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(document.body).not.toHaveTextContent('leaked-detail');
  });
});
