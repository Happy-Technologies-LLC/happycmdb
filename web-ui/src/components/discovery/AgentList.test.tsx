// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentList } from './AgentList';
import { AgentDashboard } from './AgentDashboard';
import { AgentSelector } from './AgentSelector';
import { ForbiddenHost } from '@/components/layout/ForbiddenHost';
import { apiClient } from '@/lib/api-client';
import { attachSession } from '@/lib/session';
import { usePermission } from '@/hooks/usePermission';
import { domLeaks, secretMarker } from '@/tests/utils/secretDom';

vi.mock('@/lib/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock('@/hooks/usePermission', () => ({ usePermission: vi.fn() }));

const NOW = new Date().toISOString();
const agent = (name: string, extra: Record<string, unknown> = {}) => ({
  id: `id-${name}`,
  agent_id: `agent-${name}`,
  hostname: `${name}.example.invalid`,
  status: 'active',
  provider_capabilities: ['ssh'],
  reachable_networks: ['10.0.0.0/8'],
  last_heartbeat_at: NOW,
  registered_at: NOW,
  total_jobs_completed: 3,
  total_jobs_failed: 0,
  total_cis_discovered: 12,
  ...extra,
});

function renderList() {
  return render(
    <MemoryRouter>
      <ForbiddenHost />
      <AgentList />
    </MemoryRouter>
  );
}

/** The real session client (its 403 interceptor reports to ForbiddenHost) answering every read with `status`. */
function refuseReads(status: number, body: unknown) {
  const client = axios.create({
    adapter: async (config: InternalAxiosRequestConfig) => {
      const response = { data: body, status, statusText: '', headers: {}, config, request: {} };
      throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, response);
    },
  });
  attachSession(client);
  vi.mocked(apiClient.get).mockImplementation(async (url, config) => (await client.get(url, config)).data);
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
  vi.mocked(apiClient.delete).mockReset();
  vi.mocked(usePermission).mockReset().mockReturnValue(true);
});

describe('AgentList states', () => {
  it('shows a labelled loading state, and no table or zero, until the first read answers', async () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => undefined));
    renderList();

    expect(await screen.findByRole('status')).toHaveTextContent('Loading discovery agents…');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('No agents registered')).not.toBeInTheDocument();
  });

  it('says so when no agent is registered', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ success: true, data: [] });
    renderList();

    expect(await screen.findByText('No agents registered')).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // A refresh in flight (the list re-reads every 10 s) keeps the answer on screen instead of flashing the spinner.
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => undefined));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(2));
    expect(screen.getByText('No agents registered')).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a visible, retryable error rather than a blank list, and recovers on retry', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('Network Error'));
    renderList();

    expect(await screen.findByText('Could not load discovery agents')).toBeVisible();
    expect(screen.getByText('Network Error')).toBeVisible();
    expect(screen.queryByText('No agents registered')).not.toBeInTheDocument();

    vi.mocked(apiClient.get).mockResolvedValue({ success: true, data: [agent('alpha')] });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    const table = await screen.findByRole('table', { name: 'Discovery agents' });
    expect(within(table).getByText('alpha.example.invalid')).toBeVisible();
    expect(screen.queryByText('Could not load discovery agents')).not.toBeInTheDocument();
  });

  it('keeps the rows it has and says the refresh failed when a later read fails', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({ success: true, data: [agent('alpha')] });
    renderList();
    await screen.findByRole('table', { name: 'Discovery agents' });

    vi.mocked(apiClient.get).mockRejectedValue(new Error('Network Error'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Network Error');
    expect(screen.getByText('alpha.example.invalid')).toBeVisible();
  });

  it('shows its own not-permitted state on a 403 while the shell banner shows the server reason', async () => {
    refuseReads(403, { _error: 'Forbidden', _message: "Permission 'read' required" });
    renderList();

    expect(await screen.findByText('No access to discovery agents')).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent("Access denied. Permission 'read' required");
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete agent/ })).not.toBeInTheDocument();
  });
});

describe('AgentList rows and controls', () => {
  beforeEach(() => {
    vi.mocked(apiClient.get).mockResolvedValue({
      success: true,
      data: [agent('alpha'), agent('bravo', { status: 'offline', total_jobs_failed: 2 })],
    });
  });

  it('offers the delete control only to a writer, and none to a viewer', async () => {
    vi.mocked(usePermission).mockImplementation((permission) => permission !== 'write');
    renderList();
    const viewerTable = await screen.findByRole('table', { name: 'Discovery agents' });
    expect(within(viewerTable).getByText('alpha.example.invalid')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Delete agent/ })).not.toBeInTheDocument();
  });

  it('a writer can delete: confirmation first, then DELETE of the encoded id, then a refresh', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(apiClient.delete).mockResolvedValue({ success: true });
    renderList();
    await screen.findByRole('table', { name: 'Discovery agents' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete agent agent-bravo' }));

    expect(window.confirm).toHaveBeenCalledWith('Are you sure you want to delete agent agent-bravo?');
    await waitFor(() => expect(apiClient.delete).toHaveBeenCalledWith('/agents/agent-bravo'));
    await waitFor(() => expect(vi.mocked(apiClient.get).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('shows the status as text, flags offline and never prints a zero for a rate it cannot compute', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      success: true,
      data: [agent('idle', { total_jobs_completed: 0, total_jobs_failed: 0 })],
    });
    renderList();
    const table = await screen.findByRole('table', { name: 'Discovery agents' });

    expect(within(table).getByText('ACTIVE')).toBeVisible();
    expect(within(table).getByText('N/A')).toBeVisible();
    expect(within(table).queryByText('0%')).not.toBeInTheDocument();
  });

  it('requests exactly GET /agents, and no agent credential or token field the server sends reaches the DOM', async () => {
    const marker = secretMarker('agent-token');
    vi.mocked(apiClient.get).mockResolvedValue({
      success: true,
      data: [agent('alpha', { api_key: marker, auth_token: marker, token: marker, credentials: { password: marker } })],
    });
    renderList();
    await screen.findByRole('table', { name: 'Discovery agents' });

    expect(apiClient.get).toHaveBeenCalledWith('/agents');
    expect(domLeaks(marker)).toEqual([]);
    for (const el of Array.from(document.body.querySelectorAll('[aria-label], [title], [data-testid]'))) {
      expect(`${el.getAttribute('aria-label')}${el.getAttribute('title')}${el.getAttribute('data-testid')}`).not.toMatch(
        /token|api_key|S3CR3T/i
      );
    }
  });
});

describe('AgentDashboard figures', () => {
  it('shows a dash, not a zero, for every figure when the read fails, and the numbers when it succeeds', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new Error('Network Error'));
    const { unmount } = render(
      <MemoryRouter>
        <AgentDashboard />
      </MemoryRouter>
    );

    expect(await screen.findByText('Could not load discovery agents')).toBeVisible();
    expect(screen.getAllByText('\u2013')).toHaveLength(5);
    expect(screen.getByText('Unavailable')).toBeVisible();
    for (const label of ['Total Agents', 'Active', 'Offline', 'Total Jobs', 'Success Rate']) {
      expect(screen.getByText(label).parentElement?.textContent).not.toMatch(/(^|[^\d])0(%|$)/);
    }
    unmount();

    vi.mocked(apiClient.get).mockResolvedValue({
      success: true,
      data: [agent('alpha'), agent('bravo', { status: 'offline', total_jobs_completed: 1, total_jobs_failed: 1 })],
    });
    render(
      <MemoryRouter>
        <AgentDashboard />
      </MemoryRouter>
    );
    expect(await screen.findByText('50% online')).toBeVisible();
    expect(screen.queryByText('\u2013')).not.toBeInTheDocument();
  });

  it('a fleet that has run no jobs has no success rate: N/A, not 0%', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      success: true,
      data: [agent('alpha', { total_jobs_completed: 0, total_jobs_failed: 0 })],
    });
    render(
      <MemoryRouter>
        <AgentDashboard />
      </MemoryRouter>
    );
    await screen.findByText('100% online');
    // the metric card comes before the table, whose column has the same name
    expect(screen.getAllByText('Success Rate')[0].parentElement).toHaveTextContent('N/A');
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });
});

describe('AgentSelector', () => {
  const pick = vi.fn();
  const alpha = agent('alpha', { reachable_networks: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] });
  beforeEach(() => {
    pick.mockReset();
    vi.mocked(apiClient.post).mockReset();
  });

  it('asks for the active agents of the provider and a best match for the targets, and lists them in the open select', async () => {
    const marker = secretMarker('selector-token');
    vi.mocked(apiClient.get).mockResolvedValue({ success: true, data: [{ ...alpha, api_key: marker, token: marker }] });
    vi.mocked(apiClient.post).mockResolvedValue({ success: true, data: { agent_id: 'agent-alpha' } });
    render(<AgentSelector method="agent" provider="ssh" targetNetworks={['10.1.0.0/16']} onAgentChange={pick} />);

    expect(await screen.findByText('alpha.example.invalid', { selector: 'code' })).toBeVisible();
    expect(apiClient.get).toHaveBeenCalledWith('/agents', { params: { status: 'active', provider: 'ssh' } });
    expect(apiClient.post).toHaveBeenCalledWith('/agents/find-best', { targetNetworks: ['10.1.0.0/16'], provider: 'ssh' });

    fireEvent.click(screen.getByRole('combobox', { name: 'Discovery Agent' }));
    const list = screen.getByRole('listbox');
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Auto-select (Smart Routing) - Recommended',
      'alpha.example.invalid (Best Match) [10.0.0.0/8, 172.16.0.0/12 +1 more]',
    ]);
    expect(domLeaks(marker)).toEqual([]);

    fireEvent.click(within(list).getByRole('option', { name: /alpha\.example\.invalid/ }));
    expect(pick).toHaveBeenCalledWith('agent-alpha');
  });

  it('says the read failed, with a retry, instead of claiming there are no active agents', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('Network Error'));
    render(<AgentSelector method="agent" provider="ssh" onAgentChange={pick} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load agents for provider ssh');
    expect(screen.queryByText(/No active agents found/)).not.toBeInTheDocument();

    vi.mocked(apiClient.get).mockResolvedValue({ success: true, data: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/No active agents found for provider/)).toBeVisible();
    expect(screen.queryByText(/Could not load agents/)).not.toBeInTheDocument();
  });

  it('shows the chosen agent and renders nothing for agentless discovery', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ success: true, data: [alpha] });
    const { container, rerender } = render(
      <AgentSelector method="agent" provider="ssh" selectedAgentId="agent-alpha" onAgentChange={pick} />
    );
    expect(await screen.findByText('Selected Agent Details:')).toBeVisible();
    expect(await screen.findByText('alpha.example.invalid')).toBeVisible();

    rerender(<AgentSelector method="agentless" provider="ssh" onAgentChange={pick} />);
    expect(container).toBeEmptyDOMElement();
  });
});
