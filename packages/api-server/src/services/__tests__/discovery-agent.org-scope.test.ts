// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

import { DiscoveryAgentService } from '../discovery-agent.service';
import express, { Request } from 'express';
import request from 'supertest';
import { DiscoveryAgentController } from '../../rest/controllers/discovery-agent.controller';
import type { AuthenticatedRequest } from '../../middleware/auth.middleware';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
type Row = { agent_id: string; organization_id: string | null; hostname: string; status: string;
  provider_capabilities: string[]; reachable_networks: string[]; last_heartbeat_at: Date;
  registered_at: Date; updated_at: Date; total_jobs_completed: number; total_jobs_failed: number;
  total_cis_discovered: number; tags: string[]; id: string };
const rows = new Map<string, Row>();
const row = (id: string, org: string | null): Row => ({
  agent_id: id, organization_id: org, hostname: `${id}.example`, status: 'active',
  provider_capabilities: ['nmap'], reachable_networks: ['8.8.8.0/24'],
  last_heartbeat_at: new Date(), registered_at: new Date(), updated_at: new Date(),
  total_jobs_completed: 0, total_jobs_failed: 0, total_cis_discovered: 0,
  tags: [], id,
});

// In-memory SQL boundary models the actual WHERE/ON CONFLICT predicates so an
// unscoped service reads/mutates foreign and NULL records rather than echoing mocks.
const query = jest.fn();
const executeQuery = async (sql: string, args: unknown[] = []) => {
  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
  if (sql.includes('INSERT INTO discovery_agents')) {
    const id = args[0] as string;
    const org = sql.includes('organization_id') ? args[9] as string : null;
    const existing = rows.get(id);
    if (existing && (!sql.includes('discovery_agents.organization_id = EXCLUDED.organization_id') || existing.organization_id === org)) {
      existing.hostname = args[1] as string;
      return { rows: [existing], rowCount: 1 };
    }
    if (existing) return { rows: [], rowCount: 0 };
    const added = row(id, org);
    added.hostname = args[1] as string;
    rows.set(id, added);
    return { rows: [added], rowCount: 1 };
  }
  if (sql.includes('UPDATE discovery_agents') && sql.includes('last_heartbeat_at = NOW()')) {
    const id = args[args.length - (sql.includes('AND organization_id') ? 2 : 1)] as string;
    const candidate = rows.get(id);
    if (!candidate || (sql.includes('AND organization_id') && candidate.organization_id !== args[args.length - 1])) {
      return { rows: [], rowCount: 0 };
    }
    candidate.total_jobs_completed += sql.includes('total_jobs_completed') ? args[0] as number : 0;
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes('DELETE FROM discovery_agents')) {
    const candidate = rows.get(args[0] as string);
    if (!candidate || (sql.includes('AND organization_id') && candidate.organization_id !== args[1])) return { rows: [], rowCount: 0 };
    rows.delete(candidate.agent_id);
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes('FROM discovery_agents')) {
    let visible = [...rows.values()];
    if (sql.includes('organization_id =')) visible = visible.filter(candidate => candidate.organization_id ===
      (sql.includes('organization_id = $3') ? args[2] : sql.includes('organization_id = $2') ? args[1] : args[0]));
    if (sql.includes('WHERE agent_id =')) visible = visible.filter(candidate => candidate.agent_id === args[0]);
    if (sql.includes("status = 'active'")) visible = visible.filter(candidate => candidate.status === 'active');
    return { rows: sql.includes('LIMIT 1') ? visible.slice(0, 1) : visible, rowCount: visible.length };
  }
  throw new Error('Unexpected database query');
};
jest.mock('@cmdb/database', () => ({ getPostgresClient: () => ({ query, getClient: async () => ({ query, release: () => undefined }) }) }));

const service = new DiscoveryAgentService();
const registration = (id: string, hostname = 'my.example') => ({ agent_id: id, hostname,
  provider_capabilities: ['nmap' as const], reachable_networks: ['8.8.8.0/24'] });

beforeEach(() => { rows.clear(); query.mockImplementation(executeQuery); rows.set('legacy', row('legacy', null)); });

it('isolates list/get/find-best across two orgs and excludes legacy NULL even for admin org', async () => {
  await service.registerAgent(registration('alpha'), A);
  await service.registerAgent(registration('beta'), B);
  expect((await service.listAgents(A)).map(agent => agent.agent_id)).toEqual(['alpha']);
  expect((await service.listAgents(B)).map(agent => agent.agent_id)).toEqual(['beta']);
  expect(await service.getAgent('beta', A)).toBeNull();
  expect(await service.getAgent('missing', A)).toBeNull();
  expect(await service.getAgent('legacy', A)).toBeNull();
  expect(await service.findBestAgentForNetworks(['8.8.8.0/24'], 'nmap', A)).toBe('alpha');
});

it('denies ID reuse and foreign/NULL heartbeat and delete without modifying existing data', async () => {
  await service.registerAgent(registration('alpha'), A);
  expect(await service.registerAgent(registration('alpha', 'hijacked.example'), B)).toBeNull();
  expect(await service.registerAgent(registration('legacy'), A)).toBeNull();
  expect(rows.get('alpha')?.hostname).toBe('my.example');
  for (const id of ['alpha', 'legacy', 'missing']) {
    expect(await service.updateHeartbeat({ agent_id: id, status: 'active', stats: { jobs_completed: 1 } }, B)).toBe(false);
    expect(await service.deleteAgent(id, B)).toBe(false);
  }
  expect(rows.get('alpha')?.total_jobs_completed).toBe(0);
  expect(rows.get('legacy')?.total_jobs_completed).toBe(0);
  expect(await service.getAgent('alpha', A)).not.toBeNull();
  expect(await service.deleteAgent('alpha', A)).toBe(true);
});

it('returns identical HTTP 404 for foreign, missing, and legacy NULL agents on reads and mutations', async () => {
  await service.registerAgent(registration('alpha'), A);
  const controller = new DiscoveryAgentController();
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    (req as AuthenticatedRequest).user = {
      _userId: 'admin-b', _username: 'bob', _role: 'admin', _type: 'access', _organizationId: B,
    };
    next();
  });
  app.get('/api/v1/agents/:agentId', controller.getAgent.bind(controller));
  app.delete('/api/v1/agents/:agentId', controller.deleteAgent.bind(controller));
  app.post('/api/v1/agents/heartbeat', controller.updateHeartbeat.bind(controller));
  app.post('/api/v1/agents/register', controller.registerAgent.bind(controller));
  for (const id of ['alpha', 'legacy', 'missing']) {
    const get = await request(app).get(`/api/v1/agents/${id}`);
    const del = await request(app).delete(`/api/v1/agents/${id}`);
    const heartbeat = await request(app).post('/api/v1/agents/heartbeat').send({ agent_id: id, status: 'active' });
    for (const response of [get, del, heartbeat]) {
      expect([response.status, response.body]).toEqual([404, { success: false, error: 'Agent not found' }]);
    }
    if (id !== 'missing') {
      const collision = await request(app).post('/api/v1/agents/register').send(registration(id));
      expect([collision.status, collision.body]).toEqual([404, { success: false, error: 'Agent not found' }]);
    }
  }
  expect(rows.get('alpha')?.organization_id).toBe(A);
  expect(rows.get('legacy')?.organization_id).toBeNull();
});
