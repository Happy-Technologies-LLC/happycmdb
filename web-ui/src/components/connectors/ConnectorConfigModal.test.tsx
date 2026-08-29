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
