// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const { apiClient } = vi.hoisted(() => ({ apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/lib/api-client', () => ({ apiClient }));
vi.mock('@happy-technologies/design-system', () => ({ Icon: () => null }));

import { ConnectorDefinitionList } from './ConnectorDefinitionList';
import { ConnectorMarketplace } from './ConnectorMarketplace';

const template = {
  connector_type: 'servicenow', name: 'ServiceNow CMDB', category: 'connector',
  configuration_schema: { properties: {
    instance_url: { type: 'string', title: 'Instance URL', required: true },
    username: { type: 'string', title: 'Username', required: true },
    password: { type: 'string', format: 'password', title: 'Password', required: true },
  } },
};

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.get.mockImplementation(async (path: string) => {
    if (path === '/connector-configs') return { data: [] };
    if (path === '/connectors/installed') return { data: [template] };
    if (path === '/connectors/installed/servicenow') return { data: { metadata: { resources: [] } } };
    throw new Error('Unexpected test endpoint');
  });
  apiClient.post.mockResolvedValue({ data: {
    id: 'created', name: 'My ServiceNow', connector_type: 'servicenow', enabled: true,
    schedule_enabled: false, created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-09T00:00:00Z',
  } });
});

for (const [name, Component] of [
  ['definition list', ConnectorDefinitionList],
  ['marketplace', ConnectorMarketplace],
] as const) {
  describe(`${name} wizard deployment`, () => {
    for (const scheduled of [true, false]) {
      it(`persists ${scheduled ? 'scheduled active' : 'unscheduled inactive'} wizard deployment through POST`, async () => {
        const user = userEvent.setup();
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        render(<QueryClientProvider client={queryClient}><MemoryRouter><Component /></MemoryRouter></QueryClientProvider>);

        if (name === 'definition list') {
          await user.click(screen.getByRole('button', { name: 'Install Connector' }));
          await user.click(await screen.findByRole('button', { name: 'Deploy', exact: true }));
        } else {
          await user.click(screen.getAllByRole('button', { name: 'Deploy Connector' })[0]);
        }
        await user.type(screen.getByLabelText('Connector Name *'), 'My ServiceNow');
        await user.click(screen.getByRole('switch', { name: 'Enable Schedule' }));
        fireEvent.change(screen.getByLabelText('At what time?'), { target: { value: '10:15' } });
        if (!scheduled) {
          await user.click(screen.getByRole('switch', { name: 'Enable Schedule' }));
          await user.click(screen.getByRole('switch', { name: 'Active' }));
        }
        await user.click(screen.getByRole('button', { name: 'Next' }));
        await user.type(screen.getByLabelText('Instance URL *'), 'https://tenant.example.invalid');
        await user.type(screen.getByLabelText('Username *'), 'operator');
        await user.type(screen.getByLabelText('Password *'), 'test-secret');
        await user.click(screen.getByRole('button', { name: 'Next' }));
        await user.click(screen.getAllByRole('button', { name: 'Deploy Connector' }).at(-1)!);

        await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/connector-configs', expect.objectContaining({
          name: 'My ServiceNow', connector_type: 'servicenow', enabled: scheduled,
          connection: { instance_url: 'https://tenant.example.invalid', username: 'operator', password: 'test-secret' },
          schedule_enabled: scheduled, schedule: '15 10 * * *',
        })));
      });
    }
  });
}
