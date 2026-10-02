// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant scoping for /api/v1/reconciliation, exercised through the real
 * reconciliationRoutes, ReconciliationController and identity reconciliation
 * engine behind the real AuthMiddleware/AuthService (JWT verification).
 *
 * Neo4j is an in-memory graph (`graph`) behind a fake session. It recognises
 * the statements the engine issues and evaluates them over the graph,
 * including the organization_id predicate only when the statement contains it:
 * a statement without the tenant predicate matches every organization's
 * nodes, exactly as Neo4j would. The real-Neo4j counterpart is
 * packages/identity-resolution/tests/integration/reconciliation-workflow.test.ts.
 *
 * SQL is executed by PGlite hosted in a forked child process
 * (fixtures/pglite-host.cjs) over the reconciliation tables' CREATE TABLE
 * blocks read verbatim from 001_complete_schema.sql.
 */

import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

// Placeholder config so loadConfig() validates; no Neo4j/Redis/PostgreSQL server is contacted.
// The signing secret is generated per run in memory; no literal credential.
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

// reconciliation_conflicts.ci_id is a UUID column, so the seeded CIs use UUID ids.
const CI_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const CI_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const CONFLICT_A = 'aaaaaaaa-1111-4111-8111-000000000001';
const CONFLICT_B = 'bbbbbbbb-1111-4111-8111-000000000002';
const MISSING_ID = 'cccccccc-0000-4000-8000-000000000003';

// Identifiers carried by org B's CI (and its ci_source_lineage row).
const B_IDENTIFIERS = {
  external_id: 'i-shared',
  serial_number: 'SN-SHARED',
  uuid: 'uuid-shared',
  mac_address: ['00:11:22:33:44:55'],
  fqdn: 'web-01.example.com',
};

// ---------------------------------------------------------------------------
// PGlite (child process)
// ---------------------------------------------------------------------------

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error, code }: { id: number; rows: unknown[]; error?: string; code?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(Object.assign(new Error(error), { code }));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<unknown[]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.send({ id, op, sql, params });
  });
}
const rows = <T>(sql: string, params: unknown[] = []) => send('query', sql, params) as Promise<T[]>;

let sqlCount = 0;
const pgClient = {
  // Plain function (not jest.fn): the unit config resets mock implementations.
  query: async (sql: string, params: unknown[] = []) => {
    sqlCount++;
    return { rows: await send('query', sql, params) };
  },
};

// ---------------------------------------------------------------------------
// In-memory graph and fake Neo4j session
// ---------------------------------------------------------------------------

type Props = Record<string, unknown>;
const graph = new Map<string, Props>();
let cypherCount = 0;

interface FakeRecord { keys: string[]; get(key: string): unknown }
const record = (row: Record<string, unknown>): FakeRecord => ({ keys: Object.keys(row), get: (key: string) => row[key] });

function run(rawCypher: string, params: Props): FakeRecord[] {
  const cypher = rawCypher.replace(/\s+/g, ' ').trim();
  // The tenant predicate only applies when the statement contains it.
  const inScope = cypher.includes('ci.organization_id = $organizationId')
    ? (props: Props) => props['organization_id'] === params['organizationId']
    : () => true;
  const nodes = [...graph.values()].filter(inScope);
  const ids = (matched: Props[]) => matched.map(props => record({ ci_id: props['id'] }));

  if (cypher.startsWith('CREATE (ci:CI')) {
    const props = { ...(params['properties'] as Props) };
    for (const key of Object.keys(props)) if (props[key] === null || props[key] === undefined) delete props[key];
    // ci_id_unique and ci_external_id_unique (schema.cypher) span every organization.
    for (const key of ['id', 'external_id']) {
      const clash = [...graph.values()].find(other => props[key] !== undefined && other[key] === props[key]);
      if (clash !== undefined) {
        throw Object.assign(
          new Error(`Node(1) already exists with label \`CI\` and property \`${key}\` = '${String(props[key])}'`),
          { code: 'Neo.ClientError.Schema.ConstraintValidationFailed' }
        );
      }
    }
    graph.set(props['id'] as string, props);
    return [record({ ci_id: props['id'] })];
  }
  if (cypher.includes('SET ci += $properties')) {
    const target = nodes.find(props => props['id'] === params['ciId']);
    if (target === undefined) return [];
    Object.assign(target, params['properties'], { updated_at: 'now' });
    return [record({ ci_id: target['id'], ci: { properties: target } })];
  }
  if (cypher.includes('ci.id IN $ciIds')) {
    return ids(nodes.filter(props => (params['ciIds'] as string[]).includes(props['id'] as string)));
  }
  if (cypher.includes('ANY(mac IN ci.mac_addresses WHERE mac IN $macs)')) {
    const macs = params['macs'] as string[];
    return ids(nodes.filter(props => ((props['mac_addresses'] as string[] | undefined) ?? []).some(m => macs.includes(m)))).slice(0, 1);
  }
  if (cypher.includes('ci.hostname CONTAINS $hostname')) {
    return nodes
      .filter(props =>
        String(props['hostname'] ?? '').includes(String(params['hostname'])) ||
        ((props['ip_addresses'] as string[] | undefined) ?? []).some(ip => (params['ips'] as string[]).includes(ip)))
      .slice(0, 10)
      .map(props => record({ ci_id: props['id'], hostname: props['hostname'], ips: props['ip_addresses'] }));
  }
  const attribute = /ci\.(\w+) = \$value/.exec(cypher);
  if (attribute) {
    return ids(nodes.filter(props => props[attribute[1]!] === params['value'])).slice(0, 1);
  }
  throw new Error(`fake Neo4j: unrecognised statement: ${cypher}`);
}

const neo4jClient = {
  getSession: () => ({
    run: async (cypher: string, params: Props = {}) => {
      cypherCount++;
      return { records: run(cypher, params) };
    },
    close: async () => undefined,
  }),
};

jest.mock('@cmdb/database', () => ({
  getNeo4jClient: () => neo4jClient,
  getPostgresClient: () => pgClient,
  getAuditService: () => ({}),
}));

// Kafka is not reached: reconciliation events are a no-op here.
jest.mock('@cmdb/event-processor', () => ({
  getEventProducer: () => ({ emit: async () => undefined }),
  EventType: { CI_UPDATED: 'ci_updated', CI_DISCOVERED: 'ci_discovered' },
}));

// bcrypt's native binding is only used for password hashing/login, which the
// token verification path exercised here never calls.
jest.mock('bcrypt', () => ({}));

// Users as the Neo4j store returns them; the org is a user attribute, never a request input.
const USERS: Record<string, { _id: string; _username: string; _role: string; _enabled: boolean; _organizationId?: string }> = {
  'user-a': { _id: 'user-a', _username: 'alice', _role: 'operator', _enabled: true, _organizationId: ORG_A },
  'user-b': { _id: 'user-b', _username: 'bob', _role: 'operator', _enabled: true, _organizationId: ORG_B },
  'user-none': { _id: 'user-none', _username: 'nora', _role: 'admin', _enabled: true },
};

jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (userId: string) => USERS[userId] ?? null,
    findApiKeyByKey: async () => null,
    updateApiKeyLastUsed: async () => undefined,
  })),
}));

// Imported after mocks are registered (jest hoists jest.mock).
import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { reconciliationRoutes } from '../reconciliation.routes';

const MIGRATIONS = join(__dirname, '../../../../../database/src/postgres/migrations');
const DDL_TABLES = ['reconciliation_conflicts', 'ci_source_lineage', 'ci_field_sources'];
const CI_NOT_FOUND = { success: false, error: 'Not Found', message: 'CI not found' };
const CONFLICT_NOT_FOUND = { success: false, error: 'Not Found', message: 'Conflict not found' };

function ddl(): string {
  const sql = readFileSync(join(MIGRATIONS, '001_complete_schema.sql'), 'utf8');
  return DDL_TABLES.map(table => {
    const match = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`));
    if (!match) throw new Error(`DDL for ${table} not found in 001_complete_schema.sql`);
    return match[0];
  }).join('\n');
}

const jwt = new JWTService(loadConfig().auth.jwt);
const bearer = (userId: string, organizationId?: string) => ({
  Authorization: `Bearer ${jwt.generateAccessToken(userId, USERS[userId]!._username, 'operator', organizationId)}`,
});
const AS_A = bearer('user-a', ORG_A);
const AS_B = bearer('user-b', ORG_B);
const NO_ORG = bearer('user-none');

// Mirrors server.ts: authenticate once on /api/v1, then the router.
const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/reconciliation', reconciliationRoutes);

const snapshot = () => JSON.stringify([...graph.entries()]);
const lineageOf = (ciId: string) =>
  rows<{ source_name: string; source_id: string }>('SELECT source_name, source_id FROM ci_source_lineage WHERE ci_id = $1', [ciId]);
const fieldSourcesOf = (ciId: string) =>
  rows<{ field_name: string }>('SELECT field_name FROM ci_field_sources WHERE ci_id = $1', [ciId]);

beforeAll(async () => {
  await send('exec', ddl());
});

afterAll(() => {
  host.kill();
});

beforeEach(async () => {
  graph.clear();
  graph.set(CI_A, { id: CI_A, name: 'a-db', ci_type: 'server', organization_id: ORG_A, serial_number: 'SN-A', owner: 'team-a' });
  graph.set(CI_B, {
    id: CI_B, name: 'b-web', ci_type: 'server', organization_id: ORG_B, owner: 'team-b',
    serial_number: B_IDENTIFIERS.serial_number, uuid: B_IDENTIFIERS.uuid,
    mac_addresses: B_IDENTIFIERS.mac_address, fqdn: B_IDENTIFIERS.fqdn,
  });
  await send('exec', `TRUNCATE ${DDL_TABLES.join(', ')};
    INSERT INTO ci_source_lineage (ci_id, source_name, source_id, confidence_score)
      VALUES ('${CI_B}', 'aws', '${B_IDENTIFIERS.external_id}', 100);
    INSERT INTO ci_field_sources (ci_id, field_name, field_value, source_name)
      VALUES ('${CI_A}', 'owner', 'team-a', 'manual'), ('${CI_B}', 'owner', 'team-b', 'manual');
    INSERT INTO reconciliation_conflicts (id, ci_id, conflict_type, source_data, status) VALUES
      ('${CONFLICT_A}', '${CI_A}', 'field_mismatch', '{}', 'pending'),
      ('${CONFLICT_B}', '${CI_B}', 'field_mismatch', '{"secret": "b"}', 'pending');`);
  sqlCount = 0;
  cypherCount = 0;
});

describe('/api/v1/reconciliation tenant scoping', () => {
  it("match does not return another org's CI with identical identifiers", async () => {
    const body = { identifiers: B_IDENTIFIERS, source: 'aws' };

    const asA = await request(app).post('/api/v1/reconciliation/match').set(AS_A).send(body);
    expect(asA.status).toBe(200);
    expect(asA.body.data).toBeNull();

    // Each identifier on its own is refused too, not only the first strategy tried.
    for (const [key, value] of Object.entries(B_IDENTIFIERS)) {
      const single = await request(app).post('/api/v1/reconciliation/match').set(AS_A)
        .send({ identifiers: { [key]: value }, source: 'aws' });
      expect([key, single.status, single.body.data]).toEqual([key, 200, null]);
    }

    // The owner still matches its own CI.
    const asB = await request(app).post('/api/v1/reconciliation/match').set(AS_B).send(body);
    expect(asB.body.data).toMatchObject({ ci_id: CI_B, match_strategy: 'external_id' });
  });

  it("merge with another org's identifiers does not write to that org's CI", async () => {
    const before = JSON.stringify(graph.get(CI_B));

    const res = await request(app).post('/api/v1/reconciliation/merge').set(AS_A).send({
      name: 'a-web', ci_type: 'server', source: 'aws', source_id: B_IDENTIFIERS.external_id, confidence_score: 90,
      identifiers: B_IDENTIFIERS,
      attributes: { owner: 'attacker', os: 'linux' },
    });

    expect(res.status).toBe(200);
    expect(res.body.data.ci_id).not.toBe(CI_B);
    expect(JSON.stringify(graph.get(CI_B))).toBe(before);
    expect(await fieldSourcesOf(CI_B)).toEqual([{ field_name: 'owner' }]);
    expect(await lineageOf(CI_B)).toEqual([{ source_name: 'aws', source_id: B_IDENTIFIERS.external_id }]);
    // The discovery became org A's own CI.
    expect(graph.get(res.body.data.ci_id)).toMatchObject({ organization_id: ORG_A, owner: 'attacker' });
  });

  it('merge creates the CI in the token org', async () => {
    const body = {
      name: 'a-new', ci_type: 'server', source: 'nmap', source_id: 'scan-1', confidence_score: 90,
      identifiers: { serial_number: 'SN-NEW' },
      attributes: { organization_id: ORG_B, os: 'linux' },
    };

    const created = await request(app).post('/api/v1/reconciliation/merge').set(AS_A).send(body);
    expect(created.status).toBe(200);
    const ciId = created.body.data.ci_id as string;
    expect(graph.get(ciId)).toMatchObject({ organization_id: ORG_A, serial_number: 'SN-NEW', os: 'linux' });

    // Rediscovery in org A updates the same CI; org B neither matches nor touches it.
    const again = await request(app).post('/api/v1/reconciliation/merge').set(AS_A)
      .send({ ...body, attributes: { os: 'linux-2' } });
    expect(again.body.data.ci_id).toBe(ciId);
    expect(graph.get(ciId)).toMatchObject({ organization_id: ORG_A, os: 'linux-2' });

    const asB = await request(app).post('/api/v1/reconciliation/match').set(AS_B)
      .send({ identifiers: { serial_number: 'SN-NEW' } });
    expect(asB.body.data).toBeNull();
  });

  it("merge colliding with another org's globally unique external_id is a constant 409", async () => {
    // Org B's CI stores the external_id as a node property (ci_external_id_unique is global).
    graph.get(CI_B)!['external_id'] = 'i-only-b';
    const before = snapshot();

    const res = await request(app).post('/api/v1/reconciliation/merge').set(AS_A).send({
      name: 'a-web', ci_type: 'server', source: 'gcp', source_id: 'i-only-b', confidence_score: 90,
      identifiers: { external_id: 'i-only-b', serial_number: 'SN-A-ONLY' },
      attributes: { owner: 'attacker' },
    });

    expect([res.status, res.body]).toEqual([
      409, { success: false, error: 'Conflict', message: 'A CI with these identifiers already exists' },
    ]);
    // Nothing written in either org.
    expect(snapshot()).toBe(before);
    expect(await lineageOf(CI_B)).toEqual([{ source_name: 'aws', source_id: B_IDENTIFIERS.external_id }]);
  });

  it('403 with zero queries without an org claim', async () => {
    const routes: Array<[string, string, object | null]> = [
      ['post', '/api/v1/reconciliation/match', { identifiers: B_IDENTIFIERS }],
      ['post', '/api/v1/reconciliation/merge', { name: 'x', ci_type: 'server', source: 'aws', source_id: 'i-shared', identifiers: B_IDENTIFIERS }],
      ['get', '/api/v1/reconciliation/conflicts', null],
      ['post', `/api/v1/reconciliation/conflicts/${CONFLICT_B}/resolve`, { resolution: 'accept_source' }],
      ['get', '/api/v1/reconciliation/rules', null],
      ['post', '/api/v1/reconciliation/rules', { name: 'r', identification_rules: [] }],
      ['get', '/api/v1/reconciliation/source-authorities', null],
      ['put', '/api/v1/reconciliation/source-authorities/aws', { authority_score: 9 }],
      ['get', `/api/v1/reconciliation/lineage/${CI_B}`, null],
      ['get', `/api/v1/reconciliation/field-sources/${CI_B}`, null],
    ];
    const before = snapshot();

    for (const [method, path, body] of routes) {
      const req = request(app)[method as 'get'](path).set(NO_ORG);
      const res = await (body === null ? req : req.send(body));
      expect([method, path, res.status, res.body]).toEqual([
        method, path, 403, { _error: 'Forbidden', _message: 'Organization claim required' },
      ]);
    }
    expect(sqlCount).toBe(0);
    expect(cypherCount).toBe(0);
    expect(snapshot()).toBe(before);
  });

  it("resolveConflict on another org's conflict is 404", async () => {
    const foreign = await request(app).post(`/api/v1/reconciliation/conflicts/${CONFLICT_B}/resolve`).set(AS_A)
      .send({ resolution: 'accept_source' });
    const missing = await request(app).post(`/api/v1/reconciliation/conflicts/${MISSING_ID}/resolve`).set(AS_A)
      .send({ resolution: 'accept_source' });
    const malformed = await request(app).post('/api/v1/reconciliation/conflicts/not-a-uuid/resolve').set(AS_A)
      .send({ resolution: 'accept_source' });
    expect([foreign.status, foreign.body]).toEqual([404, CONFLICT_NOT_FOUND]);
    expect([missing.status, missing.body]).toEqual([404, CONFLICT_NOT_FOUND]);
    expect([malformed.status, malformed.body]).toEqual([404, CONFLICT_NOT_FOUND]);
    expect(await rows('SELECT status FROM reconciliation_conflicts WHERE id = $1', [CONFLICT_B])).toEqual([{ status: 'pending' }]);

    // The owner resolves its own conflict.
    const own = await request(app).post(`/api/v1/reconciliation/conflicts/${CONFLICT_A}/resolve`).set(AS_A)
      .send({ resolution: 'accept_target' });
    expect(own.status).toBe(200);
    expect(await rows('SELECT status FROM reconciliation_conflicts WHERE id = $1', [CONFLICT_A])).toEqual([{ status: 'resolved' }]);
  });

  it("conflicts, lineage and field sources list only the caller org's CIs; a foreign CI id is 404", async () => {
    const conflicts = await request(app).get('/api/v1/reconciliation/conflicts').set(AS_A);
    expect(conflicts.status).toBe(200);
    expect(conflicts.body.data.map((c: { id: string }) => c.id)).toEqual([CONFLICT_A]);
    expect(conflicts.body.pagination.total).toBe(1);

    for (const kind of ['lineage', 'field-sources']) {
      const foreign = await request(app).get(`/api/v1/reconciliation/${kind}/${CI_B}`).set(AS_A);
      const missing = await request(app).get(`/api/v1/reconciliation/${kind}/${MISSING_ID}`).set(AS_A);
      expect([kind, foreign.status, foreign.body]).toEqual([kind, 404, CI_NOT_FOUND]);
      expect([kind, missing.status, missing.body]).toEqual([kind, 404, CI_NOT_FOUND]);
    }

    const fields = await request(app).get(`/api/v1/reconciliation/field-sources/${CI_A}`).set(AS_A);
    expect(fields.status).toBe(200);
    expect(fields.body.data.fields.map((f: { field_value: string }) => f.field_value)).toEqual(['team-a']);
  });
});
