// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the :BusinessService organization_id backfill (FD-16 c).
 *
 * The owner query runs on PGlite (the dim_business_services CREATE TABLE block
 * from 001_complete_schema.sql, then 008 verbatim). Neo4j is an in-memory set
 * of :BusinessService nodes behind a fake session that parses each statement's
 * MATCH / WHERE / SET / RETURN and applies exactly the predicates the statement
 * contains: a fill without `bs.organization_id IS NULL` would overwrite
 * organizations, as Neo4j would.
 */

import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import { backfillBusinessServiceOrganizations, main, type GraphSession } from '../backfill-business-service-organization';

const host = fork(join(__dirname, '../../rest/routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(new Error(error));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op, sql, params });
  return promise as Promise<Array<Record<string, unknown>>>;
}
const pg = { query: async (sql: string, params: unknown[] = []) => ({ rows: await send('query', sql, params) }) };

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const MIGRATIONS = join(__dirname, '../../../../database/src/postgres/migrations');
// Rows created before this are trusted; bs-squat's row is newer (09:30 UTC, written by
// API sessions whose TimeZone is UTC).
const CUTOVER = '2026-10-01T00:00:00Z';
const WRITER_TIMEZONE = 'Etc/UTC';

// ---------------------------------------------------------------------------
// In-memory :BusinessService nodes and a statement-parsing fake session
// ---------------------------------------------------------------------------

type Node = { id: string; organization_id?: string };
let nodes: Node[] = [];
const writes: string[] = [];
let graphRuns = 0;

interface Owner { serviceId: string; organizationId: string }

/** `WHERE` predicates the fake understands; anything else is an error, never silently true. */
function predicate(where: string): (node: Node, owner?: Owner, serviceIds?: string[]) => boolean {
  const tests = where.split(' AND ').map(clause => {
    if (clause === 'bs.organization_id IS NULL') return (n: Node) => n.organization_id === undefined;
    if (clause === 'bs.organization_id IS NOT NULL') return (n: Node) => n.organization_id !== undefined;
    if (clause === 'bs.organization_id <> owner.organizationId') {
      return (n: Node, o?: Owner) => n.organization_id !== undefined && n.organization_id !== o!.organizationId;
    }
    if (clause === 'NOT bs.id IN $serviceIds') return (n: Node, _o?: Owner, ids?: string[]) => !ids!.includes(n.id);
    throw new Error(`fake Neo4j: unmodelled predicate: ${clause}`);
  });
  return (n, o, ids) => tests.every(test => test(n, o, ids));
}

const record = (row: Record<string, unknown>) => ({ get: (key: string) => row[key] });

const session: GraphSession = {
  run: async (rawCypher, params = {}) => {
    graphRuns++;
    const cypher = rawCypher.replace(/\s+/g, ' ').trim();

    const perOwner = cypher.match(
      /^UNWIND \$owners AS owner MATCH \(bs:BusinessService \{id: owner\.serviceId\}\)(?: WHERE (.+?))?( SET bs\.organization_id = owner\.organizationId)? RETURN (.+)$/
    );
    if (perOwner) {
      const [, where, set, returns] = perOwner;
      const keep = where === undefined ? () => true : predicate(where);
      const rows: Array<Record<string, unknown>> = [];
      for (const owner of params['owners'] as Owner[]) {
        for (const node of nodes.filter(n => n.id === owner.serviceId && keep(n, owner))) {
          if (set !== undefined) {
            node.organization_id = owner.organizationId;
            writes.push(node.id);
          }
          rows.push({ serviceId: node.id, organizationId: owner.organizationId });
        }
      }
      const countAlias = returns!.match(/^count\(bs\) AS (\w+)$/);
      if (countAlias) return { records: [record({ [countAlias[1]!]: rows.length })] };
      if (returns !== 'bs.id AS serviceId, owner.organizationId AS organizationId') {
        throw new Error(`fake Neo4j: unmodelled RETURN: ${returns}`);
      }
      return { records: rows.map(record) };
    }

    const global = cypher.match(/^MATCH \(bs:BusinessService\)(?: WHERE (.+?))? RETURN count\(bs\) AS (\w+)$/);
    if (global) {
      const [, where, alias] = global;
      const keep = where === undefined ? () => true : predicate(where);
      return { records: [record({ [alias!]: nodes.filter(n => keep(n, undefined, params['serviceIds'] as string[])).length })] };
    }

    throw new Error(`fake Neo4j: unmodelled statement: ${cypher}`);
  },
};

beforeAll(async () => {
  const sql = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8');
  const ddl = sql.match(/CREATE TABLE IF NOT EXISTS dim_business_services \([\s\S]*?\n\);/);
  if (!ddl) throw new Error('DDL for dim_business_services not found in 001_complete_schema.sql');
  await send('exec', ddl[0]);
  await send('exec', `BEGIN;\n${readFileSync(join(MIGRATIONS, '008_business_service_organization_scope.sql'), 'utf8')}\nCOMMIT;`);
  await send('exec', `
INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality, operational_status, organization_id, created_at) VALUES
  ('bs-a-app', 'A App', 'application', 'application', 'high', 'active', '${ORG_A}', '2026-09-01 00:00:00'),
  ('bs-b-app', 'B App', 'application', 'application', 'high', 'active', '${ORG_B}', '2026-09-01 00:00:00'),
  ('bs-moved', 'Moved', 'application', 'application', 'high', 'active', '${ORG_A}', '2026-09-01 00:00:00'),
  ('bs-pg-only', 'Postgres Only', 'application', 'application', 'high', 'active', '${ORG_B}', '2026-09-01 00:00:00'),
  ('bs-squat', 'Claimed After Cutover', 'application', 'application', 'high', 'active', '${ORG_B}', '2026-10-01 09:30:00');`);
});

afterAll(() => {
  host.kill();
});

beforeEach(() => {
  writes.length = 0;
  graphRuns = 0;
  nodes = [
    // No organization yet; trusted Postgres owner is org A / org B.
    { id: 'bs-a-app' },
    { id: 'bs-b-app' },
    // Already org B's although Postgres now says org A: never changed.
    { id: 'bs-moved', organization_id: ORG_B },
    // Neo4j only: no Postgres row.
    { id: 'bs-graph-only' },
    // No organization; its only Postgres row was created after the cutover.
    { id: 'bs-squat' },
  ];
});

const orgs = () => Object.fromEntries(nodes.map(n => [n.id, n.organization_id ?? null]));
const APPLY = { apply: true, createdBefore: CUTOVER, writerTimezone: WRITER_TIMEZONE };

describe('backfillBusinessServiceOrganizations', () => {
  it('fills only null orgs from Postgres', async () => {
    const summary = await backfillBusinessServiceOrganizations(pg, session, APPLY);

    expect(orgs()).toEqual({
      'bs-a-app': ORG_A, 'bs-b-app': ORG_B, 'bs-moved': ORG_B, 'bs-graph-only': null, 'bs-squat': null,
    });
    expect(writes.sort()).toEqual(['bs-a-app', 'bs-b-app']);
    expect(summary).toMatchObject({
      mode: 'apply',
      postgres_services: 5,
      filled: [{ service_id: 'bs-a-app', organization_id: ORG_A }, { service_id: 'bs-b-app', organization_id: ORG_B }],
      conflicting: 1,
    });
  });

  it('is idempotent', async () => {
    await backfillBusinessServiceOrganizations(pg, session, APPLY);
    const after = JSON.stringify(nodes);
    writes.length = 0;

    const second = await backfillBusinessServiceOrganizations(pg, session, APPLY);

    expect(second.filled).toEqual([]);
    expect(writes).toEqual([]);
    expect(JSON.stringify(nodes)).toBe(after);
  });

  it('leaves unmatched nodes null', async () => {
    const summary = await backfillBusinessServiceOrganizations(pg, session, APPLY);

    expect(nodes.find(n => n.id === 'bs-graph-only')).toEqual({ id: 'bs-graph-only' });
    expect(summary.unmatched).toBe(1);
  });

  it('leaves a node claimed by a row created after the cutover null, for review', async () => {
    const summary = await backfillBusinessServiceOrganizations(pg, session, APPLY);

    expect(nodes.find(n => n.id === 'bs-squat')).toEqual({ id: 'bs-squat' });
    expect(summary.needs_review).toEqual([
      { service_id: 'bs-squat', organization_id: ORG_B, created_at: '2026-10-01 09:30:00' },
    ]);
  });

  it('reads created_at in the writer time zone, whatever the backfill session TimeZone', async () => {
    // A backfill session at UTC+14 would read bs-squat's 09:30 wall time as 2026-09-30T19:30Z,
    // before the cutover, and hand the node to the post-cutover claimant.
    await send('exec', "SET TimeZone = 'Pacific/Kiritimati'");
    try {
      const summary = await backfillBusinessServiceOrganizations(pg, session, APPLY);

      expect(nodes.find(n => n.id === 'bs-squat')).toEqual({ id: 'bs-squat' });
      expect(summary.needs_review.map(r => r.service_id)).toEqual(['bs-squat']);
      expect(writes.sort()).toEqual(['bs-a-app', 'bs-b-app']);
    } finally {
      await send('exec', 'RESET TimeZone');
    }
  });

  // POSIX offsets and abbreviation-only names are not zone files; names that are also
  // abbreviations (EST, UTC) would be read from the session's timezone_abbreviations set.
  it.each(['+05', 'UTC+5', 'PST', 'EST', 'UTC'])(
    'refuses writer time zone %s before any graph statement',
    async writerTimezone => {
      await expect(
        backfillBusinessServiceOrganizations(pg, session, { ...APPLY, writerTimezone })
      ).rejects.toThrow(/not a time zone file name in pg_timezone_names/);
      expect(graphRuns).toBe(0);
      expect(writes).toEqual([]);
    }
  );

  it('writes nothing without apply and lists what apply would fill', async () => {
    const before = JSON.stringify(nodes);

    const summary = await backfillBusinessServiceOrganizations(pg, session, { ...APPLY, apply: false });

    expect(writes).toEqual([]);
    expect(JSON.stringify(nodes)).toBe(before);
    expect(summary).toMatchObject({
      mode: 'dry-run',
      filled: [{ service_id: 'bs-a-app', organization_id: ORG_A }, { service_id: 'bs-b-app', organization_id: ORG_B }],
      needs_review: [{ service_id: 'bs-squat' }],
      unmatched: 1,
      conflicting: 1,
    });
  });
});

describe('backfill CLI', () => {
  const ENV = {
    CMDB_BACKFILL_POSTGRES_HOST: '127.0.0.1', CMDB_BACKFILL_POSTGRES_PORT: '1', CMDB_BACKFILL_POSTGRES_DB: 'unused',
    CMDB_BACKFILL_POSTGRES_USER: 'unused', CMDB_BACKFILL_POSTGRES_PASSWORD: 'pg-secret-value',
    CMDB_BACKFILL_NEO4J_URI: 'bolt://127.0.0.1:1', CMDB_BACKFILL_NEO4J_USERNAME: 'unused', CMDB_BACKFILL_NEO4J_PASSWORD: 'neo4j-secret-value',
  };

  it.each([
    [['--writer-timezone', WRITER_TIMEZONE], ENV, '--created-before <ISO-8601 timestamp with a zone> is required'],
    [['--created-before', CUTOVER, '--apply'], ENV, '--writer-timezone <IANA time zone of the API sessions> is required'],
    [['--created-before', CUTOVER, '--writer-timezone', WRITER_TIMEZONE, '--apply=false'], ENV, 'unexpected argument --apply=false'],
    [['--apply', '--created-before', CUTOVER, '--writer-timezone', WRITER_TIMEZONE, '--force'], ENV, 'unexpected argument --force'],
    [['--created-before', '2026-10-01 00:00:00', '--writer-timezone', WRITER_TIMEZONE, '--apply'], ENV, '--created-before must be an ISO-8601 timestamp with a zone'],
    [['--created-before', CUTOVER, '--writer-timezone', WRITER_TIMEZONE, '--apply'], { ...ENV, CMDB_BACKFILL_NEO4J_ENCRYPTED: 'yes' }, 'CMDB_BACKFILL_NEO4J_ENCRYPTED must be true or false'],
  ] as Array<[string[], Record<string, string>, string]>)('refuses %j before reading any store', async (argv, env, message) => {
    const out: string[] = [];
    const err: string[] = [];

    const code = await main(argv, env, { stdout: line => out.push(line), stderr: line => err.push(line) });

    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain(message);
    expect(err[0]).not.toMatch(/secret-value|ECONNREFUSED/);
  });
});
