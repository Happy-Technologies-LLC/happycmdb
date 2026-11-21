// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * cmdb.fact_ci_changes written by the scheduled change-detection ETL job.
 *
 * The job re-reads a 24 h window every 10 minutes and re-diffs each CI against
 * the dim_ci row older than the window, which never moves between runs. Runs
 * against a real PostgreSQL (PGlite) with the real cmdb.dim_ci, cmdb.dim_time
 * and cmdb.fact_ci_changes DDL (migrations 001 and 011); Neo4j is a session
 * returning fixed :CI nodes.
 */

import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Job } from 'bullmq';
import type { Neo4jClient, PostgresClient } from '@cmdb/database';
import { logger } from '@cmdb/common';

const host = fork(
  join(__dirname, '../../../../api-server/src/rest/routes/__tests__/fixtures/pglite-host.cjs'),
  [],
  { serialization: 'advanced' }
);
let nextId = 0;
const pending = new Map<number, { resolve: (r: { rows: unknown[]; rowCount?: number }) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, rowCount, error, code }: { id: number; rows: unknown[]; rowCount?: number; error?: string; code?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve({ rows, rowCount });
  // Keep the SQLSTATE, as the pg driver does.
  else p.reject(Object.assign(new Error(error), { code }));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []) {
  const id = nextId++;
  return new Promise<{ rows: unknown[]; rowCount?: number }>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.send({ id, op, sql, params });
  });
}
const rowsOf = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await send('query', sql, params)).rows as T[];

// The package index opens a Redis connection at import (bullmq queue-manager).
jest.mock('@cmdb/database', () => ({
  UNSCOPED_CI_ACCESS: Symbol('UNSCOPED_CI_ACCESS'),
}));

import { ChangeDetectionJob } from '../change-detection.job';

const INTERNAL_ORG = '00000000-0000-0000-0000-000000000000';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ORG_C = '33333333-3333-4333-8333-333333333333';
const MIGRATIONS = join(__dirname, '../../../../database/src/postgres/migrations');

const SINCE = '2026-01-01T00:00:00.000Z';
const BEFORE_SINCE = '2025-12-01T00:00:00Z';
const CREATED = '2025-12-01T00:00:00.000Z';
const UPDATED_1 = '2026-01-02T10:00:00.000Z';
const UPDATED_2 = '2026-01-03T10:00:00.000Z';

// Every statement and its parameters sent to PostgreSQL.
const sent: Array<{ sql: string; params: unknown[] }> = [];
// Fails the next matching statement with a PostgreSQL-like error.
let failure: { matches: (sql: string) => boolean; error: Error } | undefined;

const recordingQuery = async (sql: string, params: unknown[] = []) => {
  sent.push({ sql, params });
  if (failure?.matches(sql)) {
    const { error } = failure;
    failure = undefined;
    throw error;
  }
  return send('query', sql, params);
};

const postgresClient = {
  query: recordingQuery,
  transaction: async <T>(callback: (client: { query: typeof recordingQuery }) => Promise<T>): Promise<T> => {
    await send('exec', 'BEGIN');
    try {
      const result = await callback({ query: recordingQuery });
      await send('exec', 'COMMIT');
      return result;
    } catch (error) {
      await send('exec', 'ROLLBACK');
      throw error;
    }
  },
} as unknown as PostgresClient;

let nodes: Array<Record<string, unknown>> = [];
let edges: Array<Record<string, unknown>> = [];
const neo4jClient = {
  getSession: () => ({
    run: async (query: string) => ({
      records: query.includes('MATCH (from:CI)')
        ? edges.map(edge => ({ get: (key: string) => edge[key] }))
        : nodes.map(properties => ({ get: () => ({ properties }) })),
    }),
    close: async () => undefined,
  }),
} as unknown as Neo4jClient;

const node = (id: unknown, organizationId?: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `name-${String(id).slice(0, 8)}`,
  type: 'server',
  status: 'active',
  environment: 'production',
  created_at: CREATED,
  updated_at: UPDATED_1,
  metadata: '{}',
  ...(organizationId ? { organization_id: organizationId } : {}),
  ...overrides,
});

// A dim_ci version whose attributes equal node(): history (before SINCE, closed)
// or current (after SINCE).
async function dim(
  ciId: string, organizationId: string, kind: 'history' | 'current', overrides: { status?: string; metadata?: object } = {}
): Promise<number> {
  const rows = await rowsOf<{ ci_key: number }>(
    `INSERT INTO cmdb.dim_ci (ci_id, ci_name, ci_type, ci_status, environment, metadata, effective_from, effective_to,
                              is_current, organization_id, org_backfilled)
     VALUES ($1, $2, 'server', $3, 'production', $4, $5, $6, $7, $8, FALSE) RETURNING ci_key`,
    [
      ciId, `name-${ciId.slice(0, 8)}`, overrides.status ?? 'active', JSON.stringify(overrides.metadata ?? {}),
      kind === 'history' ? BEFORE_SINCE : '2026-01-01T12:00:00Z',
      kind === 'history' ? '2026-01-01T12:00:00Z' : '9999-12-31',
      kind === 'current', organizationId,
    ]
  );
  return rows[0]!.ci_key;
}

async function run(includeRelationships = false) {
  return new ChangeDetectionJob(neo4jClient, postgresClient).execute({
    id: 'job-1',
    data: { since: SINCE, includeRelationships },
    updateProgress: async () => undefined,
  } as unknown as Job);
}

const facts = () => rowsOf<{ ci_key: number; change_type: string; field_name: string; new_value: string }>(
  'SELECT ci_key, change_type, field_name, new_value FROM cmdb.fact_ci_changes ORDER BY change_key'
);

let errorLog: jest.SpyInstance;
let warnLog: jest.SpyInstance;

beforeAll(async () => {
  const schema = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8');
  const table = (name: string) => {
    const match = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`));
    if (!match) throw new Error(`DDL for ${name} not found in 001_complete_schema.sql`);
    return match[0];
  };
  const keys = schema.match(/ALTER TABLE cmdb\.fact_ci_changes\n[\s\S]*?;/);
  if (!keys) throw new Error('fact_ci_changes constraints not found in 001_complete_schema.sql');
  await send('exec', [
    'CREATE SCHEMA cmdb;',
    table('cmdb.dim_time'), table('cmdb.dim_ci'), table('cmdb.fact_ci_changes'),
    readFileSync(join(MIGRATIONS, '011_ci_organization_scope.sql'), 'utf8'),
    keys[0],
    `INSERT INTO cmdb.dim_time (date_key, full_date, year, quarter, month, month_name, week, day_of_month,
                                day_of_week, day_name, is_weekend)
     SELECT to_char(d, 'YYYYMMDD')::int, d, 2026, 1, 1, 'January', 1, 1, 1, 'Monday', FALSE
     FROM generate_series('2025-11-01'::date, '2026-02-28'::date, '1 day') AS d;`,
  ].join('\n'));
});

afterAll(() => {
  host.kill();
});

beforeEach(async () => {
  await send('exec', 'TRUNCATE cmdb.fact_ci_changes, cmdb.dim_ci RESTART IDENTITY');
  nodes = [];
  edges = [];
  sent.length = 0;
  failure = undefined;
  errorLog = jest.spyOn(logger, 'error').mockImplementation(() => logger);
  warnLog = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a change already recorded is not recorded again', () => {
  const scenarios: Array<[string, () => Promise<void>, string, string]> = [
    ['an attribute change', async () => {
      await dim('ci-1', ORG_A, 'history', { status: 'maintenance' });
      await dim('ci-1', ORG_A, 'current');
    }, 'status-changed', '_status'],
    ['a created CI (no row older than the window)', async () => {
      await dim('ci-1', ORG_A, 'current');
    }, 'created', '*'],
    ['a metadata-only change', async () => {
      await dim('ci-1', ORG_A, 'history', { metadata: { owner: 'old' } });
      await dim('ci-1', ORG_A, 'current');
    }, 'metadata-changed', 'metadata'],
  ];

  it.each(scenarios)('%s: two runs write one row, and the second run reports 0 recorded', async (_name, setup, changeType, field) => {
    await setup();
    nodes = [node('ci-1', ORG_A, changeType === 'metadata-changed' ? { metadata: '{"owner":"new"}' } : {})];

    const first = await run();
    const second = await run();

    const rows = await facts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ change_type: changeType, field_name: field });
    expect([first.changesDetected, first.changesRecorded]).toEqual([1, 1]);
    expect([second.changesDetected, second.changesRecorded]).toEqual([1, 0]);
  });

  it('a genuinely new change between two runs adds exactly one more row', async () => {
    await dim('ci-1', ORG_A, 'history', { status: 'maintenance' });
    await dim('ci-1', ORG_A, 'current');
    nodes = [node('ci-1', ORG_A)];
    await run();

    nodes = [node('ci-1', ORG_A, { status: 'decommissioned', updated_at: UPDATED_2 })];
    const second = await run();
    const third = await run();

    expect((await facts()).map(row => row.new_value)).toEqual(['"active"', '"decommissioned"']);
    expect([second.changesRecorded, third.changesRecorded]).toEqual([1, 0]);
  });

  it('a re-versioned dim_ci row (new ci_key) does not make the same change new', async () => {
    await dim('ci-1', ORG_A, 'history', { status: 'maintenance' });
    const firstKey = await dim('ci-1', ORG_A, 'current');
    nodes = [node('ci-1', ORG_A)];
    await run();

    // The SCD2 sync closes the current row and adds a later one.
    await send('exec', `UPDATE cmdb.dim_ci SET is_current = FALSE, effective_to = '2026-01-02T11:00:00Z' WHERE ci_key = ${firstKey}`);
    const secondKey = await dim('ci-1', ORG_A, 'current');
    expect(secondKey).not.toBe(firstKey);
    const second = await run();

    expect((await facts()).map(row => row.ci_key)).toEqual([firstKey]);
    expect(second.changesRecorded).toBe(0);
  });

  it('records the same change of two CIs of different organizations that share a ci_id', async () => {
    const keyA = await dim('ci-1', ORG_A, 'history', { status: 'maintenance' }).then(() => dim('ci-1', ORG_A, 'current'));
    const keyB = await dim('ci-1', ORG_B, 'history', { status: 'maintenance' }).then(() => dim('ci-1', ORG_B, 'current'));

    nodes = [node('ci-1', ORG_A)];
    await run();
    nodes = [node('ci-1', ORG_B)];
    await run();

    expect((await facts()).map(row => row.ci_key)).toEqual([keyA, keyB]);
  });
});

describe('a change is attributed to the organization of its node', () => {
  it('a created event lands on the dimension row of the node organization, never another one sharing the ci_id', async () => {
    const keyA = await dim('ci-1', ORG_A, 'current');
    const keyB = await dim('ci-1', ORG_B, 'current');
    nodes = [node('ci-1', ORG_B)];

    await run();

    const rows = await facts();
    expect(rows.map(row => row.ci_key)).toEqual([keyB]);
    expect(rows[0]!.ci_key).not.toBe(keyA);
  });

  it('diffs against the history of the node organization', async () => {
    // A's history equals the node, so only B's history yields a change.
    await dim('ci-1', ORG_A, 'history');
    await dim('ci-1', ORG_A, 'current');
    await dim('ci-1', ORG_B, 'history', { status: 'maintenance' });
    const keyB = await dim('ci-1', ORG_B, 'current');
    nodes = [node('ci-1', ORG_B)];

    await run();

    const rows = await facts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ci_key: keyB, change_type: 'status-changed' });
  });

  it('a node whose organization has no dim_ci row records nothing, and never writes on another organization', async () => {
    await dim('ci-1', ORG_A, 'history', { status: 'maintenance' });
    await dim('ci-1', ORG_A, 'current');
    nodes = [node('ci-1', ORG_C)];

    const result = await run();

    expect(await facts()).toEqual([]);
    expect([result.changesDetected, result.changesRecorded]).toEqual([1, 0]);
    expect(errorLog).toHaveBeenCalledWith('Error recording change', expect.objectContaining({ ciId: 'ci-1', changeType: 'created' }));
  });

  it('a node without organization_id is the internal organization', async () => {
    await dim('ci-1', ORG_A, 'current');
    const internalKey = await dim('ci-1', INTERNAL_ORG, 'current');
    nodes = [node('ci-1')];

    await run();

    expect((await facts()).map(row => row.ci_key)).toEqual([internalKey]);
  });

  it('a relationship between nodes of different organizations is not recorded', async () => {
    await dim('ci-from', ORG_A, 'current');
    await dim('ci-to', ORG_B, 'current');
    edges = [{
      fromId: 'ci-from', fromName: 'from', fromOrganizationId: ORG_A,
      toId: 'ci-to', toName: 'to', toOrganizationId: ORG_B,
      relType: 'DEPENDS_ON', createdAt: UPDATED_1, updatedAt: UPDATED_1,
    }];

    const result = await run(true);

    expect(await facts()).toEqual([]);
    expect([result.changesDetected, result.changesRecorded]).toEqual([0, 0]);
  });

  it('a relationship inside one organization is recorded once on its FROM CI, however often it is re-read', async () => {
    const fromKey = await dim('ci-from', ORG_A, 'current');
    const otherKey = await dim('ci-from', ORG_B, 'current');
    edges = [{
      fromId: 'ci-from', fromName: 'from', fromOrganizationId: ORG_A,
      toId: 'ci-to', toName: 'to', toOrganizationId: ORG_A,
      relType: 'DEPENDS_ON', createdAt: UPDATED_1, updatedAt: UPDATED_1,
    }];

    await run(true);
    const second = await run(true);

    const rows = await facts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ci_key: fromKey, change_type: 'relationship-added' });
    expect(rows[0]!.ci_key).not.toBe(otherKey);
    expect(second.changesRecorded).toBe(0);
  });
});

describe('a node id that cannot be a cmdb.dim_ci ci_id', () => {
  it('is skipped and logged without its value; valid nodes are still processed', async () => {
    const longId = 'x'.repeat(101);
    await dim('ci-ok', ORG_A, 'current');
    nodes = [node(12345, ORG_A), node(longId, ORG_A), node('nul\u0000id', ORG_A), node('ci-ok', ORG_A)];

    const result = await run();

    expect(result.cisChecked).toBe(1);
    expect((await facts()).map(row => row.change_type)).toEqual(['created']);
    expect(warnLog).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ job: 'change-detection', skipped: 3 }));
    const logged = JSON.stringify([...warnLog.mock.calls, ...errorLog.mock.calls]);
    expect(logged).not.toContain(longId);
    expect(logged).not.toContain('12345');
    expect(logged).not.toContain('nul');
    const params = JSON.stringify(sent.map(s => s.params));
    expect(params).not.toContain(longId);
    expect(params).not.toContain('12345');
  });
});

describe('a record failure log line', () => {
  const SECRET = 'customer-secret-metadata';

  it('names the CI and the error class, never the change values', async () => {
    await dim('ci-1', ORG_A, 'current');
    nodes = [node('ci-1', ORG_A, { metadata: JSON.stringify({ token: SECRET }) })];
    const driverError = Object.assign(new Error(`invalid input ... ${SECRET}`), { code: '22P02' });
    failure = { matches: sql => sql.includes('INSERT INTO cmdb.fact_ci_changes'), error: driverError };

    const result = await run();

    expect(result.changesRecorded).toBe(0);
    expect(await facts()).toEqual([]);
    expect(errorLog).toHaveBeenCalledTimes(1);
    const [message, fields] = errorLog.mock.calls[0]!;
    expect(message).toBe('Error recording change');
    expect(fields).toEqual({ ciId: 'ci-1', changeType: 'created', errorClass: 'Error', code: '22P02' });
    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain('oldValue');
    expect(logged).not.toContain('newValue');
  });
});
