// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the :BusinessService organization_id backfill (FD-16 c).
 *
 * The owner query runs on PGlite (the dim_business_services CREATE TABLE block
 * from 001_complete_schema.sql, then 008 verbatim). Neo4j is an in-memory set
 * of :BusinessService nodes behind a fake session that parses each statement's
 * MATCH / WHERE / SET and applies exactly the predicates the statement
 * contains: a fill without `bs.organization_id IS NULL` would overwrite
 * organizations, as Neo4j would.
 */

import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

import { backfillBusinessServiceOrganizations, type GraphSession } from '../backfill-business-service-organization';

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

// ---------------------------------------------------------------------------
// In-memory :BusinessService nodes and a statement-parsing fake session
// ---------------------------------------------------------------------------

type Node = { id: string; organization_id?: string };
let nodes: Node[] = [];
const writes: string[] = [];

interface Owner { serviceId: string; organizationId: string }

/** `WHERE` predicates the fake understands; anything else is an error, never silently true. */
function predicate(where: string): (node: Node, owner?: Owner, serviceIds?: string[]) => boolean {
  const clauses = where.split(' AND ');
  const tests = clauses.map(clause => {
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

const session: GraphSession = {
  run: async (rawCypher, params = {}) => {
    const cypher = rawCypher.replace(/\s+/g, ' ').trim();
    const one = (alias: string, value: number) => ({ records: [{ get: (key: string) => (key === alias ? value : undefined) }] });

    const perOwner = cypher.match(
      /^UNWIND \$owners AS owner MATCH \(bs:BusinessService \{id: owner\.serviceId\}\)(?: WHERE (.+?))?( SET bs\.organization_id = owner\.organizationId)? RETURN count\(bs\) AS (\w+)$/
    );
    if (perOwner) {
      const [, where, set, alias] = perOwner;
      const keep = where === undefined ? () => true : predicate(where);
      let matched = 0;
      for (const owner of params['owners'] as Owner[]) {
        for (const node of nodes.filter(n => n.id === owner.serviceId && keep(n, owner))) {
          matched++;
          if (set !== undefined) {
            node.organization_id = owner.organizationId;
            writes.push(node.id);
          }
        }
      }
      return one(alias!, matched);
    }

    const global = cypher.match(/^MATCH \(bs:BusinessService\)(?: WHERE (.+?))? RETURN count\(bs\) AS (\w+)$/);
    if (global) {
      const [, where, alias] = global;
      const keep = where === undefined ? () => true : predicate(where);
      return one(alias!, nodes.filter(n => keep(n, undefined, params['serviceIds'] as string[])).length);
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
INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower, business_criticality, operational_status, organization_id) VALUES
  ('bs-a-app', 'A App', 'application', 'application', 'high', 'active', '${ORG_A}'),
  ('bs-b-app', 'B App', 'application', 'application', 'high', 'active', '${ORG_B}'),
  ('bs-moved', 'Moved', 'application', 'application', 'high', 'active', '${ORG_A}'),
  ('bs-pg-only', 'Postgres Only', 'application', 'application', 'high', 'active', '${ORG_B}');`);
});

afterAll(() => {
  host.kill();
});

beforeEach(() => {
  writes.length = 0;
  nodes = [
    // No organization yet; Postgres owner is org A / org B.
    { id: 'bs-a-app' },
    { id: 'bs-b-app' },
    // Already org B's although Postgres now says org A: never changed.
    { id: 'bs-moved', organization_id: ORG_B },
    // Neo4j only: no Postgres row.
    { id: 'bs-graph-only' },
  ];
});

const orgs = () => Object.fromEntries(nodes.map(n => [n.id, n.organization_id ?? null]));

describe('backfillBusinessServiceOrganizations', () => {
  it('fills only null orgs from Postgres', async () => {
    const summary = await backfillBusinessServiceOrganizations(pg, session, { apply: true });

    expect(orgs()).toEqual({ 'bs-a-app': ORG_A, 'bs-b-app': ORG_B, 'bs-moved': ORG_B, 'bs-graph-only': null });
    expect(writes.sort()).toEqual(['bs-a-app', 'bs-b-app']);
    expect(summary).toEqual({ mode: 'apply', postgres_services: 4, filled: 2, unmatched: 1, conflicting: 1 });
  });

  it('is idempotent', async () => {
    await backfillBusinessServiceOrganizations(pg, session, { apply: true });
    const after = JSON.stringify(nodes);
    writes.length = 0;

    const second = await backfillBusinessServiceOrganizations(pg, session, { apply: true });

    expect(second.filled).toBe(0);
    expect(writes).toEqual([]);
    expect(JSON.stringify(nodes)).toBe(after);
  });

  it('leaves unmatched nodes null', async () => {
    const summary = await backfillBusinessServiceOrganizations(pg, session, { apply: true });

    expect(nodes.find(n => n.id === 'bs-graph-only')).toEqual({ id: 'bs-graph-only' });
    expect(summary.unmatched).toBe(1);
  });

  it('writes nothing without apply and reports what apply would fill', async () => {
    const before = JSON.stringify(nodes);

    const summary = await backfillBusinessServiceOrganizations(pg, session, { apply: false });

    expect(writes).toEqual([]);
    expect(JSON.stringify(nodes)).toBe(before);
    expect(summary).toEqual({ mode: 'dry-run', postgres_services: 4, filled: 2, unmatched: 1, conflicting: 1 });
  });
});
