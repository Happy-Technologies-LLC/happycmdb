// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * cmdb.dim_ci.organization_id written by the neo4j-to-postgres ETL job
 * (migration 011). The real Neo4jToPostgresJob runs against PGlite (hosted
 * in a forked child process, ../../../../api-server/src/rest/routes/__tests__/
 * fixtures/pglite-host.cjs) with the cmdb.dim_ci and cmdb.fact_discovery
 * CREATE TABLE blocks read verbatim from 001_complete_schema.sql plus
 * 011_ci_organization_scope.sql. Neo4j is a session returning fixed :CI nodes.
 */

import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Job } from 'bullmq';
import type { Neo4jClient, PostgresClient } from '@cmdb/database';

const host = fork(
  join(__dirname, '../../../../api-server/src/rest/routes/__tests__/fixtures/pglite-host.cjs'),
  [],
  { serialization: 'advanced' }
);
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(new Error(error));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<unknown[]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.send({ id, op, sql, params });
  });
}
const query = async (sql: string, params: unknown[] = []) => ({ rows: await send('query', sql, params) });

// The package index opens a Redis connection at import (bullmq queue-manager);
// the job only needs the unscoped-access token from it.
jest.mock('@cmdb/database', () => ({ UNSCOPED_CI_ACCESS: Symbol('UNSCOPED_CI_ACCESS') }));

import { Neo4jToPostgresJob } from '../neo4j-to-postgres.job';

const INTERNAL_ORG = '00000000-0000-0000-0000-000000000000';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const MIGRATIONS = join(__dirname, '../../../../database/src/postgres/migrations');

// One PGlite connection: BEGIN/COMMIT around the callback is a real transaction.
const postgresClient = {
  query,
  transaction: async <T>(callback: (client: { query: typeof query }) => Promise<T>): Promise<T> => {
    await send('exec', 'BEGIN');
    try {
      const result = await callback({ query });
      await send('exec', 'COMMIT');
      return result;
    } catch (error) {
      await send('exec', 'ROLLBACK');
      throw error;
    }
  },
} as unknown as PostgresClient;

let nodes: Array<Record<string, unknown>> = [];
const neo4jClient = {
  getSession: () => ({
    run: async () => ({ records: nodes.map(properties => ({ get: () => ({ properties }) })) }),
    close: async () => undefined,
  }),
} as unknown as Neo4jClient;

// Attributes equal to the stored rows below, so no CI is re-versioned for them.
const node = (id: string, organizationId?: string) => ({
  id, name: id, type: 'server', status: 'active', environment: 'production',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', discovered_at: '2026-01-01T00:00:00Z',
  metadata: JSON.stringify({ discovery_source: 'test', discovery_method: 'manual' }),
  ...(organizationId === undefined ? {} : { organization_id: organizationId }),
});

async function sync(): Promise<void> {
  // Incremental: the relationship pass (not under test) is skipped.
  const job = { id: 'job-1', data: { incrementalSince: '2026-01-01T00:00:00Z' }, updateProgress: async () => undefined };
  await new Neo4jToPostgresJob(neo4jClient, postgresClient).execute(job as unknown as Job);
}

const versions = (ciId: string) => send(
  'query', 'SELECT is_current, organization_id FROM cmdb.dim_ci WHERE ci_id = $1 ORDER BY ci_key', [ciId]
);

beforeAll(async () => {
  const schema = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8');
  const ddl = ['cmdb.dim_ci', 'cmdb.fact_discovery'].map(table => {
    const match = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`));
    if (!match) throw new Error(`DDL for ${table} not found in 001_complete_schema.sql`);
    return match[0];
  });
  await send('exec', `CREATE SCHEMA cmdb;\n${ddl.join('\n')}\n${readFileSync(join(MIGRATIONS, '011_ci_organization_scope.sql'), 'utf8')}`);
});

afterAll(() => {
  host.kill();
});

beforeEach(async () => {
  await send('exec', 'TRUNCATE cmdb.dim_ci, cmdb.fact_discovery RESTART IDENTITY');
});

it('relabels every version of a CI to the organization its node names, without a new version', async () => {
  // As 011 leaves a customer CI synced before it: every version in the internal org.
  await send('exec', `INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id) VALUES
    ('ci-b', 'ci-b', 'server', 'active', 'production', FALSE, '${INTERNAL_ORG}'),
    ('ci-b', 'ci-b', 'server', 'active', 'production', TRUE, '${INTERNAL_ORG}');`);
  nodes = [node('ci-b', ORG_B)];

  await sync();

  expect(await versions('ci-b')).toEqual([
    { is_current: false, organization_id: ORG_B },
    { is_current: true, organization_id: ORG_B },
  ]);
});

it('an org-less node keeps the stored organization; a new org-less CI goes to the internal organization', async () => {
  await send('exec', `INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id) VALUES
    ('ci-kept', 'ci-kept', 'server', 'active', 'production', TRUE, '${ORG_B}');`);
  nodes = [node('ci-kept'), node('ci-new'), node('ci-new-b', ORG_B)];

  await sync();

  expect(await versions('ci-kept')).toEqual([{ is_current: true, organization_id: ORG_B }]);
  expect(await versions('ci-new')).toEqual([{ is_current: true, organization_id: INTERNAL_ORG }]);
  expect(await versions('ci-new-b')).toEqual([{ is_current: true, organization_id: ORG_B }]);
});
