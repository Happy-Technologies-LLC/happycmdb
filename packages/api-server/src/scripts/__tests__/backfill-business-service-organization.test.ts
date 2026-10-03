// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the :BusinessService organization_id backfill (FD-16 c).
 *
 * The owner query runs on PGlite (the dim_business_services CREATE TABLE block
 * from 001_complete_schema.sql, then 008 verbatim). Neo4j is an in-memory set
 * of :BusinessService nodes and HAS_BACKFILL_INCARNATION edges (by node object
 * identity, so a replacement node never inherits an edge) behind a fake
 * session. The count statements are parsed and only the predicates they
 * contain are applied; prepare / fillable / fill are matched to the exported
 * statements and modelled with their documented semantics. The real
 * statements run against Neo4j in
 * tests/integration/database/business-service-backfill.integration.test.ts.
 */

import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import {
  backfillBusinessServiceOrganizations, FILL_CYPHER, FILLABLE_CYPHER, INCARNATION_CONSTRAINT_CYPHER, main,
  PREPARE_CYPHER, prepareBusinessServiceIncarnations, type GraphSession, type SqlClient,
} from '../backfill-business-service-organization';

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
const pg: SqlClient = {
  query: async (sql, params = []) => ({ rows: await send('query', sql, params) }),
  transaction: async callback => {
    await send('exec', 'BEGIN');
    try {
      const result = await callback(pg);
      await send('exec', 'COMMIT');
      return result;
    } catch (error) {
      await send('exec', 'ROLLBACK');
      throw error;
    }
  },
};

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

type Node = { id: string; elementId: string; organization_id?: string };
let nodes: Node[] = [];
/** HAS_BACKFILL_INCARNATION edges; `node` is the node object itself. */
let edges: Array<{ node: Node; uuid: string }> = [];
let nextAnchor = 0;
const writes: string[] = [];
let graphRuns = 0;

const normalize = (cypher: string) => cypher.replace(/\s+/g, ' ').trim();
const outDegree = (n: Node) => edges.filter(e => e.node === n).length;
const inDegree = (uuid: string) => edges.filter(e => e.uuid === uuid).length;

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
    const cypher = normalize(rawCypher);

    if (cypher === normalize(INCARNATION_CONSTRAINT_CYPHER)) return { records: [] };
    if (cypher === normalize(PREPARE_CYPHER)) {
      const rows = nodes
        .filter(n => n.organization_id === undefined && outDegree(n) === 0)
        .map(n => {
          const uuid = `00000000-0000-4000-8000-${String(++nextAnchor).padStart(12, '0')}`;
          edges.push({ node: n, uuid });
          return { serviceId: n.id, incarnation: uuid };
        })
        .sort((a, b) => a.serviceId.localeCompare(b.serviceId));
      return { records: rows.map(record) };
    }
    if (cypher === normalize(FILLABLE_CYPHER)) {
      const rows: Array<Record<string, unknown>> = [];
      for (const owner of params['owners'] as Owner[]) {
        for (const node of nodes.filter(n => n.id === owner.serviceId && n.organization_id === undefined)) {
          rows.push({
            serviceId: node.id, elementId: node.elementId, organizationId: owner.organizationId,
            anchorEdges: outDegree(node),
            incarnations: edges.filter(e => e.node === node && inDegree(e.uuid) === 1).map(e => e.uuid),
          });
        }
      }
      return { records: rows.map(record) };
    }
    if (cypher === normalize(FILL_CYPHER)) {
      const rows: Array<Record<string, unknown>> = [];
      for (const target of params['targets'] as Array<Owner & { elementId: string; incarnation: string }>) {
        for (const edge of edges.filter(e => e.node.id === target.serviceId && e.uuid === target.incarnation)) {
          const node = edge.node;
          if (node.organization_id !== undefined || node.elementId !== target.elementId ||
              outDegree(node) !== 1 || inDegree(edge.uuid) !== 1) continue;
          node.organization_id = target.organizationId;
          writes.push(node.id);
          rows.push({ serviceId: node.id, elementId: node.elementId, incarnation: edge.uuid, organizationId: node.organization_id });
        }
      }
      return { records: rows.map(record) };
    }

    const perOwner = cypher.match(
      /^UNWIND \$owners AS owner MATCH \(bs:BusinessService \{id: owner\.serviceId\}\)(?: WHERE (.+?))? RETURN (.+)$/
    );
    if (perOwner) {
      const [, where, returns] = perOwner;
      const keep = where === undefined ? () => true : predicate(where);
      const rows: Node[] = [];
      for (const owner of params['owners'] as Owner[]) {
        rows.push(...nodes.filter(n => n.id === owner.serviceId && keep(n, owner)));
      }
      const countAlias = returns!.match(/^count\(bs\) AS (\w+)$/);
      if (!countAlias) throw new Error(`fake Neo4j: unmodelled RETURN: ${returns}`);
      return { records: [record({ [countAlias[1]!]: rows.length })] };
    }
    const global = cypher.match(/^MATCH \(bs:BusinessService\)(?: WHERE (.+?))? RETURN count\(bs\) AS (\w+)$/);
    if (global) {
      const [, where, alias] = global;
      const keep = where === undefined ? () => true : predicate(where);
      return { records: [record({ [alias!]: nodes.filter(n => keep(n, undefined, params['serviceIds'] as string[])).length })] };
    }

    throw new Error(`fake Neo4j: unmodelled statement: ${cypher}`);
  },
  executeWrite: async callback => {
    const savedNodes = [...nodes];
    const savedOrgs = nodes.map(n => n.organization_id);
    const savedEdges = [...edges];
    const priorWrites = writes.length;
    try {
      return await callback(session);
    } catch (error) {
      nodes = savedNodes;
      nodes.forEach((n, i) => { n.organization_id = savedOrgs[i]; });
      edges = savedEdges;
      writes.length = priorWrites;
      throw error;
    }
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

beforeEach(async () => {
  nodes = [
    { id: 'bs-a-app', elementId: 'node-a' },
    { id: 'bs-b-app', elementId: 'node-b' },
    // Already org B's although Postgres now says org A: never changed.
    { id: 'bs-moved', elementId: 'node-moved', organization_id: ORG_B },
    // Neo4j only: no Postgres row.
    { id: 'bs-graph-only', elementId: 'node-only' },
    // No organization; its only Postgres row was created after the cutover.
    { id: 'bs-squat', elementId: 'node-squat' },
  ];
  edges = [];
  // Every test starts from a prepared graph (anchors on all org-less nodes).
  await prepareBusinessServiceIncarnations(session);
  writes.length = 0;
  graphRuns = 0;
});

/** The anchor UUID the beforeEach prepare gave this node. */
const anchorOf = (id: string) => edges.find(e => e.node.id === id)!.uuid;

const orgs = () => Object.fromEntries(nodes.map(n => [n.id, n.organization_id ?? null]));
const APPLY = { apply: true, createdBefore: CUTOVER, writerTimezone: WRITER_TIMEZONE };
const dryRun = () => backfillBusinessServiceOrganizations(pg, session, { ...APPLY, apply: false });
const apply = async () => {
  const reviewed = await dryRun();
  return backfillBusinessServiceOrganizations(pg, session, { ...APPLY, reviewed, sha256: reviewed.plan_sha256 });
};

describe('backfillBusinessServiceOrganizations', () => {
  it('fills only null orgs from Postgres', async () => {
    const summary = await apply();

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
    await apply();
    const after = JSON.stringify(nodes);
    writes.length = 0;

    const second = await apply();

    expect(second.filled).toEqual([]);
    expect(writes).toEqual([]);
    expect(JSON.stringify(nodes)).toBe(after);
  });

  it('leaves unmatched nodes null', async () => {
    const summary = await apply();

    expect(nodes.find(n => n.id === 'bs-graph-only')).toEqual({ id: 'bs-graph-only', elementId: 'node-only' });
    expect(summary.unmatched).toBe(1);
  });

  it('leaves a node claimed by a row created after the cutover null, for review', async () => {
    const summary = await apply();

    expect(nodes.find(n => n.id === 'bs-squat')).toEqual({ id: 'bs-squat', elementId: 'node-squat' });
    expect(summary.needs_review).toEqual([
      { service_id: 'bs-squat', organization_id: ORG_B, created_at: '2026-10-01 09:30:00' },
    ]);
  });

  it('reads created_at in the writer time zone, whatever the backfill session TimeZone', async () => {
    // A backfill session at UTC+14 would read bs-squat's 09:30 wall time as 2026-09-30T19:30Z,
    // before the cutover, and hand the node to the post-cutover claimant.
    await send('exec', "SET TimeZone = 'Pacific/Kiritimati'");
    try {
      const summary = await apply();

      expect(nodes.find(n => n.id === 'bs-squat')).toEqual({ id: 'bs-squat', elementId: 'node-squat' });
      expect(summary.needs_review.map(r => r.service_id)).toEqual(['bs-squat']);
      expect(writes.sort()).toEqual(['bs-a-app', 'bs-b-app']);
    } finally {
      await send('exec', 'RESET TimeZone');
    }
  });

  it('uses the given writer time zone, not a fixed one', async () => {
    // Written by UTC+14 sessions, bs-squat's 09:30 wall time is 2026-09-30T19:30Z: before the cutover.
    const reviewed = await backfillBusinessServiceOrganizations(pg, session, { ...APPLY, apply: false, writerTimezone: 'Pacific/Kiritimati' });
    const summary = await backfillBusinessServiceOrganizations(pg, session, {
      ...APPLY, writerTimezone: 'Pacific/Kiritimati', reviewed, sha256: reviewed.plan_sha256,
    });

    expect(summary.needs_review).toEqual([]);
    expect(summary.filled).toContainEqual({ service_id: 'bs-squat', organization_id: ORG_B, incarnation: anchorOf('bs-squat') });
  });

  // POSIX offsets and abbreviation-only names are not zone files; names that are also
  // abbreviations (EST, UTC) would be read from the session's timezone_abbreviations set.
  it.each(['+05', 'UTC+5', 'PST', 'EST', 'UTC'])(
    'refuses writer time zone %s before any graph statement',
    async writerTimezone => {
      await expect(
        backfillBusinessServiceOrganizations(pg, session, { ...APPLY, apply: false, writerTimezone })
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
    expect(summary.plan?.targets).toEqual([
      { serviceId: 'bs-a-app', organizationId: ORG_A, elementId: 'node-a', incarnation: anchorOf('bs-a-app') },
      { serviceId: 'bs-b-app', organizationId: ORG_B, elementId: 'node-b', incarnation: anchorOf('bs-b-app') },
    ]);
    expect(summary.needs_prepare).toEqual([]);
  });

  it('prepare anchors each org-less node once and writes no organization', async () => {
    expect(edges.map(e => e.node.id).sort()).toEqual(['bs-a-app', 'bs-b-app', 'bs-graph-only', 'bs-squat']);
    expect(new Set(edges.map(e => e.uuid)).size).toBe(4);

    const again = await prepareBusinessServiceIncarnations(session);

    expect(again).toEqual({ mode: 'prepare', prepared: [] });
    expect(edges).toHaveLength(4);
    expect(orgs()['bs-a-app']).toBeNull();
  });

  it('plans no unanchored node and lists it in needs_prepare', async () => {
    edges = edges.filter(e => e.node.id !== 'bs-b-app');

    const summary = await dryRun();

    expect(summary.needs_prepare).toEqual([{ service_id: 'bs-b-app', organization_id: ORG_B }]);
    expect(summary.plan?.targets.map(t => t.serviceId)).toEqual(['bs-a-app']);
  });

  it('emits no plan when a node has more than one anchor', async () => {
    edges.push({ node: nodes[1]!, uuid: '00000000-0000-4000-8000-999999999999' });

    await expect(dryRun()).rejects.toThrow(/ambiguous incarnation anchor/);
  });

  it('rejects ownership drift after review against PostgreSQL before graph writes', async () => {
    const reviewed = await dryRun();
    await send('query', 'UPDATE dim_business_services SET organization_id = $1 WHERE service_id = $2', [ORG_B, 'bs-a-app']);
    try {
      await expect(backfillBusinessServiceOrganizations(pg, session, {
        ...APPLY, reviewed, sha256: reviewed.plan_sha256,
      })).rejects.toThrow(/Postgres ownership\/cutover drift/);
      expect(writes).toEqual([]);
      expect(orgs()['bs-a-app']).toBeNull();
    } finally {
      await send('query', 'UPDATE dim_business_services SET organization_id = $1 WHERE service_id = $2', [ORG_A, 'bs-a-app']);
    }
  });

  it('rolls back both org writes if a reviewed node was deleted and recreated', async () => {
    const reviewed = await dryRun();
    nodes[1] = { id: 'bs-b-app', elementId: 'replacement-b' };
    edges = edges.filter(e => nodes.includes(e.node));
    await expect(backfillBusinessServiceOrganizations(pg, session, {
      ...APPLY, reviewed, sha256: reviewed.plan_sha256,
    })).rejects.toThrow(/Neo4j identity\/organization drift/);
    expect(writes).toEqual([]);
    expect(orgs()['bs-a-app']).toBeNull();
    expect(orgs()['bs-b-app']).toBeNull();
  });

  it('gives no organization to a same-id node recreated with the same elementId and copied properties', async () => {
    const reviewed = await dryRun();
    // Neo4j may reuse an elementId after deletion; the replacement copies every property
    // but, being a new node, not the reviewed node's anchor edge.
    nodes[1] = { ...nodes[1]! };
    edges = edges.filter(e => nodes.includes(e.node));
    const applyReviewed = () => backfillBusinessServiceOrganizations(pg, session, {
      ...APPLY, reviewed, sha256: reviewed.plan_sha256,
    });
    await expect(applyReviewed()).rejects.toThrow(/Neo4j identity\/organization drift/);
    // Preparing the replacement gives it a new anchor, which is not the reviewed one.
    await prepareBusinessServiceIncarnations(session);
    await expect(applyReviewed()).rejects.toThrow(/Neo4j identity\/organization drift/);
    expect(writes).toEqual([]);
    expect(orgs()['bs-a-app']).toBeNull();
    expect(orgs()['bs-b-app']).toBeNull();
  });

  it('preserves a foreign organization if ownership flips after review', async () => {
    const reviewed = await dryRun();
    nodes[1]!.organization_id = ORG_A;
    await expect(backfillBusinessServiceOrganizations(pg, session, {
      ...APPLY, reviewed, sha256: reviewed.plan_sha256,
    })).rejects.toThrow(/Neo4j identity\/organization drift/);
    expect(writes).toEqual([]);
    expect(orgs()['bs-a-app']).toBeNull();
    expect(orgs()['bs-b-app']).toBe(ORG_A);
  });

  it('rejects changed plans and applies neither organization', async () => {
    const reviewed = await dryRun();
    reviewed.plan!.targets[0]!.organizationId = ORG_B;
    await expect(backfillBusinessServiceOrganizations(pg, session, {
      ...APPLY, reviewed, sha256: reviewed.plan_sha256,
    })).rejects.toThrow(/intact dry-run/);
    expect(writes).toEqual([]);
    expect(orgs()['bs-a-app']).toBeNull();
  });

  it('refuses apply without a reviewed manifest', async () => {
    await expect(backfillBusinessServiceOrganizations(pg, session, APPLY)).rejects.toThrow(/intact dry-run/);
    expect(graphRuns).toBe(0);
    expect(writes).toEqual([]);
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
    [['--created-before', '2026-10-01 00:00:00', '--writer-timezone', WRITER_TIMEZONE], ENV, '--created-before must be an ISO-8601 timestamp with a zone'],
    [['--created-before', CUTOVER, '--writer-timezone', WRITER_TIMEZONE], { ...ENV, CMDB_BACKFILL_NEO4J_ENCRYPTED: 'yes' }, 'CMDB_BACKFILL_NEO4J_ENCRYPTED must be true or false'],
    [['--created-before', CUTOVER, '--writer-timezone', WRITER_TIMEZONE, '--apply'], ENV, '--apply requires --plan'],
    [['--prepare', '--apply'], ENV, 'unexpected argument --prepare'],
    [['--created-before', CUTOVER, '--writer-timezone', WRITER_TIMEZONE, '--prepare'], ENV, 'unexpected argument --prepare'],
    [['--prepare'], { CMDB_BACKFILL_NEO4J_URI: 'bolt://127.0.0.1:1', CMDB_BACKFILL_NEO4J_USERNAME: 'unused' }, 'CMDB_BACKFILL_NEO4J_PASSWORD is required'],
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
