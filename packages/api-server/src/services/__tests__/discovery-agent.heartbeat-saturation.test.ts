// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * DiscoveryAgentService.updateHeartbeat adds per-heartbeat deltas to the INTEGER counters
 * total_jobs_completed, total_jobs_failed and total_cis_discovered. Plain addition raises
 * 22003 "integer out of range" once the running total passes 2^31-1; updateHeartbeat then
 * rolls back, so last_heartbeat_at and status are lost and the agent looks offline for good.
 * The totals saturate at 2^31-1 instead. The SQL runs on real PostgreSQL (PGlite, hosted by
 * ../../rest/routes/__tests__/fixtures/pglite-host.cjs) over the discovery_agents DDL of
 * 001_complete_schema.sql plus organization_id (migration 019), so the INT4 limit is enforced.
 */

import { describe, it, expect, jest, beforeAll, beforeEach, afterAll } from '@jest/globals';
import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('@cmdb/common', () => ({
  ...jest.requireActual<object>('@cmdb/common'),
  logger: { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));
jest.mock('@cmdb/database', () => ({ getPostgresClient: jest.fn() }));

import { getPostgresClient } from '@cmdb/database';
import { DiscoveryAgentService } from '../discovery-agent.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const AGENT = 'agent-1';
const INT4_MAX = 2147483647;
const OLD_HEARTBEAT = '2026-01-01T00:00:00.000Z';

const host = fork(join(__dirname, '../../rest/routes/__tests__/fixtures/pglite-host.cjs'), [], {
  serialization: 'advanced',
});
let serial = 0;
type Result = { rows: Record<string, any>[]; rowCount?: number };
const pending = new Map<number, PromiseWithResolvers<Result>>();
host.on('message', ({ id, rows, rowCount, error }: Result & { id: number; error?: string }) => {
  const entry = pending.get(id)!;
  pending.delete(id);
  if (error) entry.reject(new Error(error));
  else entry.resolve({ rows, rowCount });
});
function run(text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query') {
  const id = serial++;
  const entry = Promise.withResolvers<Result>();
  pending.set(id, entry);
  host.send({ id, op, sql: text, params });
  return entry.promise;
}
const sql = async (text: string, params: unknown[] = [], op: 'query' | 'exec' = 'query') =>
  (await run(text, params, op)).rows;

const agentRow = async () => (await sql('SELECT * FROM discovery_agents WHERE agent_id = $1', [AGENT]))[0];

// Counter arithmetic only: an org-wide caller, so the owner predicate (discovery-agent.owner-binding.test.ts) is out of play.
function heartbeat(stats: Record<string, number>) {
  return new DiscoveryAgentService().updateHeartbeat({ agent_id: AGENT, status: 'active', stats } as any, ORG,
    { principalId: 'operator-1', orgWide: true });
}

beforeAll(async () => {
  const schema = readFileSync(
    join(__dirname, '../../../../database/src/postgres/migrations/001_complete_schema.sql'),
    'utf8'
  );
  const table = schema.match(/CREATE TABLE IF NOT EXISTS discovery_agents \([\s\S]*?\n\);/)![0];
  await sql(`${table}\nALTER TABLE discovery_agents ADD COLUMN organization_id UUID;`, [], 'exec');
}, 60_000);
afterAll(() => {
  host.kill();
});
beforeEach(async () => {
  // jest.config.unit.js sets resetMocks: true, so the client stub is re-installed per test.
  (getPostgresClient as jest.Mock).mockReturnValue({
    query: (text: string, params: unknown[] = []) => run(text, params),
    getClient: async () => ({
      query: (text: string, params: unknown[] = []) => run(text, params),
      release: () => undefined,
    }),
  });
  await sql('TRUNCATE discovery_agents', [], 'exec');
  await sql(
    `INSERT INTO discovery_agents (agent_id, hostname, organization_id, last_heartbeat_at, status)
     VALUES ($1, 'host', $2::uuid, $3::timestamptz, 'inactive')`,
    [AGENT, ORG, OLD_HEARTBEAT]
  );
});

describe('updateHeartbeat counter accumulation on PostgreSQL', () => {
  it('adds each delta to its running total below the INT4 limit', async () => {
    expect(await heartbeat({ jobs_completed: 2, jobs_failed: 1, cis_discovered: 8 })).toBe(true);
    expect(await heartbeat({ jobs_completed: 3, jobs_failed: 0, cis_discovered: 4 })).toBe(true);

    const row = await agentRow();
    expect([row['total_jobs_completed'], row['total_jobs_failed'], row['total_cis_discovered']]).toEqual([5, 1, 12]);
  });

  it.each([
    ['jobs_completed', 'total_jobs_completed'],
    ['jobs_failed', 'total_jobs_failed'],
    ['cis_discovered', 'total_cis_discovered'],
  ])('saturates %s at 2^31-1 and still refreshes last_heartbeat_at and status', async (stat, column) => {
    expect(await heartbeat({ [stat]: INT4_MAX })).toBe(true);
    expect((await agentRow())[column]).toBe(INT4_MAX);

    await sql('UPDATE discovery_agents SET last_heartbeat_at = $1::timestamptz, status = $2', [OLD_HEARTBEAT, 'inactive']);

    // One more delta, and one that alone is far past the remaining headroom.
    expect(await heartbeat({ [stat]: 1 })).toBe(true);
    expect(await heartbeat({ [stat]: 1_000_000 })).toBe(true);

    const row = await agentRow();
    expect(row[column]).toBe(INT4_MAX);
    expect(new Date(row['last_heartbeat_at']).getTime()).toBeGreaterThan(new Date(OLD_HEARTBEAT).getTime());
    expect(row['status']).toBe('active');
  });

  it('saturates when two deltas sum past 2^31-1 and leaves the other counters alone', async () => {
    await sql('UPDATE discovery_agents SET total_jobs_completed = $1, total_jobs_failed = 7', [INT4_MAX - 10]);

    expect(await heartbeat({ jobs_completed: 1_000_000 })).toBe(true);

    const row = await agentRow();
    expect(row['total_jobs_completed']).toBe(INT4_MAX);
    expect(row['total_jobs_failed']).toBe(7);
  });
});

describe('findBestAgentForNetworks with saturated counters', () => {
  it('ranks an agent whose completed and failed totals sum past 2^31-1 instead of failing the lookup', async () => {
    await sql(
      `UPDATE discovery_agents SET provider_capabilities = ARRAY['nmap'], reachable_networks = ARRAY['8.8.8.0/24']::cidr[],
         status = 'active', last_heartbeat_at = now(), total_jobs_completed = $1, total_jobs_failed = $1`,
      [INT4_MAX]
    );

    await expect(new DiscoveryAgentService().findBestAgentForNetworks(['8.8.8.0/24'], 'nmap' as any, ORG)).resolves.toBe(AGENT);
  });
});
