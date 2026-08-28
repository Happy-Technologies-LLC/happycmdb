// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// Final cycle-10 live-component retest. F-044: connector install wizard
// (owns config/step transitions confirm->configure->test->complete;
// installMutation fires from the 'test' step; canProceed gates Next/Install;
// dashboard/close terminal actions).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { connectorService } = vi.hoisted(() => ({
  connectorService: { installConnector: vi.fn() },
}));

vi.mock('@/services/connector.service', () => ({
  default: connectorService,
  __esModule: true,
}));

import { ConnectorInstallWizard } from './ConnectorInstallWizard';

const CONNECTOR = {
  connectorType: 'c10fc-wizard-connector',
  category: 'CONNECTOR' as const,
  name: 'Wizard Test Connector',
  description: 'A connector used to test the install wizard',
  verified: true,
  latestVersion: '1.2.3',
  versions: [],
  author: 'Happy Technologies',
  homepage: '',
  repository: '',
  license: 'proprietary',
  downloads: 0,
  rating: 0,
  tags: [],
  metadata: {},
};

function renderWizard(onComplete = vi.fn(), onClose = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ConnectorInstallWizard connector={CONNECTOR} onClose={onClose} onComplete={onComplete} />
    </QueryClientProvider>
  );
  return { onComplete, onClose };
}

describe('ConnectorInstallWizard (F-044)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('steps confirm -> configure -> test, calling installConnector only once "Install" is pressed on the test step', async () => {
    const user = userEvent.setup();
    connectorService.installConnector.mockResolvedValue({ success: true });
    renderWizard();

    expect(screen.getByText('Confirm Installation')).toBeInTheDocument();
    expect(connectorService.installConnector).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByText('Configure Connector')).toBeInTheDocument();
    expect(connectorService.installConnector).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByText('Ready to Install')).toBeInTheDocument();
    expect(connectorService.installConnector).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Install/i }));

    await waitFor(() => {
      expect(connectorService.installConnector).toHaveBeenCalledWith(CONNECTOR.connectorType);
    });
  });

  it('on install success, transitions to the complete step; "Go to Connectors Dashboard" fires onComplete', async () => {
    const user = userEvent.setup();
    connectorService.installConnector.mockResolvedValue({ success: true });
    const { onComplete } = renderWizard();

    await user.click(screen.getByRole('button', { name: /Next/i }));
    await user.click(screen.getByRole('button', { name: /Next/i }));
    await user.click(screen.getByRole('button', { name: /Install/i }));

    expect(await screen.findByText('Installation Complete!')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Go to Connectors Dashboard/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('handleBack returns to the previous step; Back is disabled on the first step', async () => {
    const user = userEvent.setup();
    renderWizard();

    expect(screen.getByRole('button', { name: /Back/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByText('Configure Connector')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Back/i })).not.toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Back/i }));
    expect(screen.getByText('Confirm Installation')).toBeInTheDocument();
  });

  it('Cancel on any step invokes onClose', async () => {
    const user = userEvent.setup();
    const { onClose } = renderWizard();
    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
