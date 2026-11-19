// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
//
// Connector marketplace (HAP-1922 S8j): write gating by role, the exact API calls an operator's actions make,
// the four read states for deployed connectors, category filtering, and tone-plus-text status badges.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { ForbiddenHost } from '@/components/layout/ForbiddenHost';
import { attachSession } from '@/lib/session';
import { ConnectorMarketplace } from './ConnectorMarketplace';

const { apiClient, permission } = vi.hoisted(() => ({
  apiClient: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  permission: { write: true },
}));
vi.mock('@/lib/api-client', () => ({ apiClient }));
// Level-aware, like the real hook: every role holds `read`; `permission.write` switches the write level (and above).
vi.mock('@/hooks/usePermission', () => ({ usePermission: (level: string) => level === 'read' || permission.write }));

const config = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, name: `Deployed ${id}`, connector_type: 'servicenow', enabled: true,
  schedule_enabled: false, created_at: '2026-10-09T00:00:00Z', updated_at: '2026-10-10T12:00:00Z', ...overrides,
});
const CONFIGS = [config('a'), config('b', { enabled: false })];

function serve(configs: () => Promise<unknown>) {
  apiClient.get.mockImplementation(async (path: string) => {
    if (path === '/connector-configs') return configs();
    if (path === '/connectors/installed/servicenow') return { data: { metadata: { resources: [] } } };
    throw new Error('Unexpected test endpoint');
  });
}
const configsOk = (rows: unknown[]) => () => Promise.resolve({ success: true, data: rows });

/** The real session client (its 403 interceptor reports to ForbiddenHost) answering every read with a refusal. */
function refuseReads() {
  const client = axios.create({
    adapter: async (cfg: InternalAxiosRequestConfig) => {
      const response = {
        data: { _error: 'Forbidden', _message: "Permission 'read' required" },
        status: 403, statusText: '', headers: {}, config: cfg, request: {},
      };
      throw new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', cfg, {}, response);
    },
  });
  attachSession(client);
  apiClient.get.mockImplementation((url: string, cfg?: unknown) => client.get(url, cfg as never));
}

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ForbiddenHost />
        <ConnectorMarketplace />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const WRITE_CONTROL = /\b(deploy connector|run now|configure|delete)\b/i;
const writeControls = () => screen.queryAllByRole('button').filter((b) => WRITE_CONTROL.test(b.textContent || b.getAttribute('aria-label') || ''));

beforeEach(() => {
  permission.write = true;
  apiClient.get.mockReset();
  apiClient.post.mockReset();
  apiClient.delete.mockReset();
  apiClient.post.mockResolvedValue({ data: {} });
  apiClient.delete.mockResolvedValue({});
});

describe('marketplace write gating', () => {
  it('shows an operator every write control: deploy per template, run, configure and delete per connector', async () => {
    serve(configsOk(CONFIGS));
    mount();

    await screen.findByText('Deployed a');
    expect(screen.getAllByRole('button', { name: 'Deploy Connector' })).toHaveLength(6);
    expect(screen.getAllByRole('button', { name: 'Run Now' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Configure Deployed a' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Delete Deployed a' })).toBeVisible();
  });

  it('shows a viewer the catalog and the deployed connectors but no write action', async () => {
    permission.write = false;
    serve(configsOk(CONFIGS));
    mount();

    await screen.findByText('Deployed a');
    expect(screen.getByText('ServiceNow CMDB')).toBeVisible();
    expect(screen.getByText('Datadog')).toBeVisible();
    expect(screen.getByText('Deployed b')).toBeVisible();
    expect(writeControls()).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Deploy Connector' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run Now' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Configure Deployed a' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Deployed a' })).toBeNull();
  });

  it('runs and deletes with the connector configuration id and nothing else', async () => {
    const user = userEvent.setup();
    serve(configsOk(CONFIGS));
    mount();
    await screen.findByText('Deployed a');

    await user.click(screen.getAllByRole('button', { name: 'Run Now' })[0]);
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledTimes(1));
    expect(apiClient.post).toHaveBeenCalledWith('/connector-configs/a/run');

    await user.click(screen.getByRole('button', { name: 'Delete Deployed b' }));
    await waitFor(() => expect(apiClient.delete).toHaveBeenCalledTimes(1));
    expect(apiClient.delete).toHaveBeenCalledWith('/connector-configs/b');
  });

  it('opens the configuration wizard for the chosen template', async () => {
    const user = userEvent.setup();
    serve(configsOk([]));
    mount();
    await screen.findByText('No connectors deployed yet');

    await user.click(screen.getAllByRole('button', { name: 'Deploy Connector' })[0]);

    expect(await screen.findByText('Configure ServiceNow CMDB')).toBeVisible();
  });
});

describe('marketplace catalog', () => {
  it('filters the templates by category and marks the active filter', async () => {
    const user = userEvent.setup();
    serve(configsOk([]));
    mount();
    await screen.findByText('No connectors deployed yet');
    expect(screen.getByText('Custom Connector')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Monitoring & Observability' }));

    expect(screen.getByRole('button', { name: 'Monitoring & Observability' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All Connectors' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Datadog')).toBeVisible();
    expect(screen.getByText('Splunk')).toBeVisible();
    expect(screen.queryByText('ServiceNow CMDB')).not.toBeInTheDocument();
    expect(screen.queryByText('Custom Connector')).not.toBeInTheDocument();
  });

  it('keeps the catalog usable while the deployed list fails to load', async () => {
    serve(() => Promise.reject(new Error('upstream exploded')));
    mount();

    await screen.findByText('Could not load deployed connectors');
    expect(screen.getByText('ServiceNow CMDB')).toBeVisible();
  });
});

describe('deployed connectors states', () => {
  it('shows a busy placeholder, not an empty or error message, while the read is in flight', async () => {
    serve(() => new Promise(() => undefined));
    const { container } = mount();

    await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).not.toBeNull());
    expect(screen.queryByText('No connectors deployed yet')).not.toBeInTheDocument();
    expect(screen.queryByText('Could not load deployed connectors')).not.toBeInTheDocument();
  });

  it('says so when nothing is deployed', async () => {
    serve(configsOk([]));
    mount();

    expect(await screen.findByText('No connectors deployed yet')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Run Now/ })).not.toBeInTheDocument();
  });

  it('shows a visible, retryable error for a failed read, never a blank section', async () => {
    const user = userEvent.setup();
    serve(() => Promise.reject(new Error('upstream exploded')));
    mount();

    expect(await screen.findByText('Could not load deployed connectors')).toBeVisible();
    expect(screen.getByText('upstream exploded')).toBeVisible();

    serve(configsOk(CONFIGS));
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Deployed a')).toBeVisible();
    expect(screen.queryByText('Could not load deployed connectors')).not.toBeInTheDocument();
  });

  it('shows its own not-permitted state on a 403 while the shell banner shows the server reason, with no retry', async () => {
    refuseReads();
    mount();

    expect(await screen.findByText('No access to deployed connectors')).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent("Access denied. Permission 'read' required");
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('labels each connector status in text with its own tone', async () => {
    serve(configsOk([config('a'), config('b', { enabled: false })]));
    mount();

    const active = within((await screen.findByText('Deployed a')).closest('div.flex.items-start') as HTMLElement).getByText('active');
    const inactive = within(screen.getByText('Deployed b').closest('div.flex.items-start') as HTMLElement).getByText('inactive');
    expect(active.className).not.toBe(inactive.className);
  });
});
