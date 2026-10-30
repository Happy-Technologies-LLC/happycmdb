// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
// HAP-1234: the Agent views call /agents through the shared apiClient, so the stored session's Bearer header is sent.
import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';
vi.mock('@happy-technologies/design-system', () => ({ Icon: () => null, Eyebrow: () => null }));
// Built at runtime from neutral parts; it only has to round-trip from localStorage into the header.
const SEEDED = ['h1234', 'agents', Date.now().toString(36)].join('-');
const AGENTS = ['alpha', 'bravo'].map((n, i) => ({ id: n, agent_id: `agent-${n}`, hostname: `syn-${n}.example.invalid`, status: i ? 'offline' : 'active', provider_capabilities: ['nmap'], reachable_networks: ['10.0.0.0/8'], last_heartbeat_at: new Date().toISOString(), registered_at: new Date().toISOString(), total_jobs_completed: 1, total_jobs_failed: 0, total_cis_discovered: 0 }));
const seen: InternalAxiosRequestConfig[] = [];
// No real network: every request, shared client or raw axios, ends here after its interceptors ran.
axios.defaults.adapter = async (config) => {
  seen.push(config);
  const data = config.url?.endsWith('/find-best') ? { success: true, data: { agent_id: AGENTS[0].agent_id } } : { success: true, data: AGENTS };
  return { data, status: 200, statusText: 'OK', headers: {}, config };
};
// apiClient copies axios.defaults (adapter included) when its module loads, so the views load after the adapter is set.
const [{ AgentList }, { AgentDashboard }, { AgentSelector }] = await Promise.all([import('./AgentList'), import('./AgentDashboard'), import('./AgentSelector')]);
beforeEach(() => { seen.length = 0; localStorage.setItem('auth_token', SEEDED); });
const sent = (route: string) => seen.filter((c) => `${c.baseURL ?? ''}${c.url}` === `/api/v1${route}`);
const expectAuthorized = async (route: string, count = 1) => {
  await waitFor(() => expect(sent(route).length).toBeGreaterThanOrEqual(count));
  for (const c of sent(route)) expect(c.headers.Authorization).toBe(`Bearer ${SEEDED}`);
};
it('AgentList sends the stored Bearer header to /api/v1/agents and renders the returned rows (HAP-1234)', async () => {
  render(<AgentList />);
  await expectAuthorized('/agents');
  expect(await screen.findByText(AGENTS[1].hostname)).toBeInTheDocument();
});
it('AgentDashboard sends the header on its stats and list requests and computes the stats (HAP-1234)', async () => {
  render(<AgentDashboard />);
  await expectAuthorized('/agents', 2);
  expect(await screen.findByText('50% online')).toBeInTheDocument();
});
it('AgentSelector sends the header on /agents and /agents/find-best and shows the recommendation (HAP-1234)', async () => {
  render(<AgentSelector method="agent" provider="nmap" targetNetworks={['10.0.0.0/8']} onAgentChange={() => {}} />);
  await expectAuthorized('/agents');
  await expectAuthorized('/agents/find-best');
  expect(await screen.findByText(AGENTS[0].hostname, { selector: 'code' })).toBeInTheDocument();
});
