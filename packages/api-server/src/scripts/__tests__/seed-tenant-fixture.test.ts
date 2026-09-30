// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the tenant fixture seed: CLI and target validation, the
 * PostgreSQL scratch check, and the business-service upsert against PGlite
 * (the dim_business_services CREATE TABLE block from 001_complete_schema.sql,
 * then 008 verbatim).
 *
 * The full script (real migrator, real Neo4j users, login through the API, the
 * CLI as a real process) is exercised by
 * packages/api-server/tests/integration/seed-tenant-fixture.test.ts.
 */

import { fork, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { createServer, type AddressInfo, type Server } from 'net';
import { join } from 'path';

import {
  inspectPostgres, main, parseSpec, parseTarget, seedBusinessServices, MIGRATIONS_DIR, type TenantFixtureSpec,
} from '../seed-tenant-fixture';

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

const INTERNAL_ORG = '00000000-0000-0000-0000-000000000000';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const PASSWORDS = { CMDB_SEED_SERVICE_USER_PASSWORD: 'svc-password-1234', CMDB_SEED_NO_ORG_USER_PASSWORD: 'noorg-password-5678' };
const TARGET_ENV = {
  CMDB_SEED_POSTGRES_HOST: '127.0.0.1', CMDB_SEED_POSTGRES_PORT: '5432', CMDB_SEED_POSTGRES_DB: 'scratch',
  CMDB_SEED_POSTGRES_USER: 'seed', CMDB_SEED_POSTGRES_PASSWORD: 'pg-secret-value',
  CMDB_SEED_NEO4J_URI: 'bolt://localhost:7687', CMDB_SEED_NEO4J_USERNAME: 'neo4j', CMDB_SEED_NEO4J_PASSWORD: 'neo4j-secret-value',
};
const ARGS: Record<string, string> = {
  '--target': 'scratch',
  '--organization-id': ORG_A,
  '--service-id': 'bs-co1-fulfillment',
  '--inactive-service-id': 'bs-co1-retired',
  '--other-organization-id': ORG_B,
  '--other-service-id': 'bs-co1-foreign',
  '--service-user': 'co1hive',
  '--no-org-user': 'co1noorg',
};
const argv = (overrides: Record<string, string> = {}) =>
  Object.entries({ ...ARGS, ...overrides }).flat();

beforeAll(async () => {
  const sql = readFileSync(join(MIGRATIONS_DIR, '001_complete_schema.sql'), 'utf8');
  const table = sql.match(/CREATE TABLE IF NOT EXISTS dim_business_services \([\s\S]*?\n\);/);
  if (!table) throw new Error('dim_business_services DDL not found');
  await send('exec', table[0] + '\n' + readFileSync(join(MIGRATIONS_DIR, '008_business_service_organization_scope.sql'), 'utf8'));
});

afterAll(() => {
  host.kill();
});

describe('parseSpec', () => {
  it('accepts the documented arguments and reads passwords only from the environment', () => {
    expect(parseSpec(argv({ '--organization-id': ORG_B.toUpperCase(), '--other-organization-id': ORG_A }), PASSWORDS))
      .toEqual({
        organizationId: ORG_B,
        serviceId: 'bs-co1-fulfillment',
        inactiveServiceId: 'bs-co1-retired',
        otherOrganizationId: ORG_A,
        otherServiceId: 'bs-co1-foreign',
        serviceUser: { username: 'co1hive', password: PASSWORDS.CMDB_SEED_SERVICE_USER_PASSWORD },
        noOrgUser: { username: 'co1noorg', password: PASSWORDS.CMDB_SEED_NO_ORG_USER_PASSWORD },
      });
  });

  const withoutTarget = argv().slice(2);
  it.each([
    ['a missing --target acknowledgement', withoutTarget, PASSWORDS, /--target is required/],
    ['a target other than scratch', argv({ '--target': 'staging' }), PASSWORDS, /--target must be "scratch"/],
    ['the internal organization as organization A', argv({ '--organization-id': INTERNAL_ORG }), PASSWORDS, /must not be the internal organization/],
    ['the internal organization as the other organization', argv({ '--other-organization-id': INTERNAL_ORG }), PASSWORDS,
      /--other-organization-id must not be the internal organization/],
    ['a non-UUID organization', argv({ '--organization-id': 'org-a' }), PASSWORDS, /--organization-id must be a UUID/],
    ['the same organization twice', argv({ '--other-organization-id': ORG_A }), PASSWORDS, /must differ/],
    ['a service id the API would reject', argv({ '--service-id': 'fulfillment' }), PASSWORDS, /must match/],
    ['a service id longer than the column', argv({ '--service-id': `bs-${'a'.repeat(48)}` }), PASSWORDS, /must match/],
    ['duplicate service ids', argv({ '--other-service-id': 'bs-co1-fulfillment' }), PASSWORDS, /three service ids must differ/],
    ['a username the login schema rejects', argv({ '--service-user': 'co1-hive' }), PASSWORDS, /must match/],
    ['the same user twice', argv({ '--no-org-user': 'CO1HIVE' }), PASSWORDS, /must differ/],
    ['a password shorter than the login schema allows', argv(), { ...PASSWORDS, CMDB_SEED_NO_ORG_USER_PASSWORD: 'short' }, /at least 8/],
    ['a missing password', argv(), { CMDB_SEED_SERVICE_USER_PASSWORD: 'svc-password-1234' }, /CMDB_SEED_NO_ORG_USER_PASSWORD must be set/],
    ['an unknown flag', [...argv(), '--password', 'x'], PASSWORDS, /unknown argument "--password"/],
    ['a repeated flag', [...argv(), '--service-id', 'bs-other'], PASSWORDS, /--service-id given more than once/],
    ['a missing value', argv().slice(0, -1), PASSWORDS, /--no-org-user is required/],
  ])('rejects %s', (_label, args, env, message) => {
    expect(() => parseSpec(args, env)).toThrow(message);
  });
});

describe('parseTarget', () => {
  it('reads only the dedicated CMDB_SEED_* settings, accepting loopback hosts', () => {
    expect(parseTarget({ ...TARGET_ENV, CMDB_SEED_NEO4J_URI: 'bolt://[::1]:7687', POSTGRES_HOST: '10.0.0.9' })).toEqual({
      postgres: { host: '127.0.0.1', port: 5432, database: 'scratch', user: 'seed', password: 'pg-secret-value' },
      neo4j: { uri: 'bolt://[::1]:7687', username: 'neo4j', password: 'neo4j-secret-value' },
    });
  });

  it.each([
    ['NODE_ENV=production', { ...TARGET_ENV, NODE_ENV: 'production' }, /refusing to run with NODE_ENV=production/],
    ['a non-loopback PostgreSQL host', { ...TARGET_ENV, CMDB_SEED_POSTGRES_HOST: 'db.internal' },
      /CMDB_SEED_POSTGRES_HOST must be loopback .* got "db.internal"/],
    ['a non-loopback Neo4j host', { ...TARGET_ENV, CMDB_SEED_NEO4J_URI: 'bolt://10.1.2.3:7687' },
      /CMDB_SEED_NEO4J_URI host must be loopback .* got "10.1.2.3"/],
    ['a loopback-looking Neo4j host with userinfo', { ...TARGET_ENV, CMDB_SEED_NEO4J_URI: 'bolt://localhost@neo4j.prod:7687' },
      /must be exactly bolt:\/\/<host>\[:port\], with no credentials/],
    ['a Neo4j URI with a routing-context query', { ...TARGET_ENV, CMDB_SEED_NEO4J_URI: 'bolt://localhost:7687?policy=eu' },
      /must be exactly bolt:\/\/<host>\[:port\]/],
    ['a Neo4j URI with a path', { ...TARGET_ENV, CMDB_SEED_NEO4J_URI: 'bolt://localhost:7687/other' },
      /must be exactly bolt:\/\/<host>\[:port\]/],
    ...['neo4j://localhost:7687', 'neo4j+s://localhost:7687', 'neo4j+ssc://localhost:7687', 'bolt+routing://localhost:7687',
      'bolt+s://localhost:7687', 'http://localhost:7474'].map(uri =>
      [`the non-direct Neo4j URI ${uri}`, { ...TARGET_ENV, CMDB_SEED_NEO4J_URI: uri }, /must be a direct bolt:\/\/ URI/] as const),
    ['a bad port', { ...TARGET_ENV, CMDB_SEED_POSTGRES_PORT: '54x' }, /CMDB_SEED_POSTGRES_PORT must be a port number/],
    ['only the api-server settings', { POSTGRES_HOST: '127.0.0.1', NEO4J_URI: 'bolt://127.0.0.1:7687' },
      /CMDB_SEED_POSTGRES_HOST must be set/],
  ])('refuses %s', (_label, env, message) => {
    expect(() => parseTarget(env)).toThrow(message);
  });
});

describe('main', () => {
  it('refuses a non-scratch target before connecting, without echoing any password', async () => {
    const out: string[] = [];
    const code = await main(argv(), { ...PASSWORDS, ...TARGET_ENV, NODE_ENV: 'production' }, {
      stdout: l => out.push(`stdout:${l}`),
      stderr: l => out.push(`stderr:${l}`),
    });
    expect(code).toBe(1);
    expect(out).toEqual(['stderr:seed-tenant-fixture: refusing to run with NODE_ENV=production']);
  });

  it('refuses a missing --target before reading any connection setting', async () => {
    const out: string[] = [];
    const code = await main(argv().slice(2), { ...PASSWORDS }, { stdout: l => out.push(l), stderr: l => out.push(l) });
    expect(code).toBe(1);
    expect(out).toEqual(['seed-tenant-fixture: --target is required']);
  });
});

describe('inspectPostgres (PGlite)', () => {
  it('calls a database with tables but no marker foreign, and one with the marker a fixture', async () => {
    expect(await inspectPostgres(pg)).toBe('foreign');
    await send('exec', 'CREATE SCHEMA IF NOT EXISTS cmdb; CREATE TABLE cmdb.tenant_fixture_marker (created_at TIMESTAMPTZ)');
    try {
      expect(await inspectPostgres(pg)).toBe('fixture');
    } finally {
      await send('exec', 'DROP TABLE cmdb.tenant_fixture_marker');
    }
  });
});

describe('seedBusinessServices (PGlite)', () => {
  const spec: TenantFixtureSpec = parseSpec(argv(), PASSWORDS);
  const rows = () => send(
    'query',
    `SELECT service_id, organization_id, operational_status, name, metadata
     FROM dim_business_services ORDER BY service_id`
  );
  const insertForeign = (serviceId: string, org: string, metadata: string | null) => send(
    'query',
    `INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower,
       business_criticality, operational_status, organization_id, metadata)
     VALUES ($1, 'Real service', 'data', 'data', 'critical', 'active', $2, $3::jsonb)`,
    [serviceId, org, metadata]
  );

  beforeEach(async () => {
    await send('exec', 'TRUNCATE dim_business_services CASCADE');
  });

  const MARK = { tenant_fixture: true };
  const EXPECTED = [
    { service_id: 'bs-co1-foreign', organization_id: ORG_B, operational_status: 'active', name: 'Fixture bs-co1-foreign', metadata: MARK },
    { service_id: 'bs-co1-fulfillment', organization_id: ORG_A, operational_status: 'active', name: 'Fixture bs-co1-fulfillment', metadata: MARK },
    { service_id: 'bs-co1-retired', organization_id: ORG_A, operational_status: 'inactive', name: 'Fixture bs-co1-retired', metadata: MARK },
  ];

  it('creates the active and inactive org-A services and the other organization service, marked as fixtures', async () => {
    const seeded = await seedBusinessServices(pg, spec);
    expect(seeded).toEqual([
      { service_id: 'bs-co1-fulfillment', organization_id: ORG_A, operational_status: 'active' },
      { service_id: 'bs-co1-retired', organization_id: ORG_A, operational_status: 'inactive' },
      { service_id: 'bs-co1-foreign', organization_id: ORG_B, operational_status: 'active' },
    ]);
    expect(await rows()).toEqual(EXPECTED);
  });

  it('is idempotent and converges drifted fixture rows back to the declared state', async () => {
    await seedBusinessServices(pg, spec);
    await send('exec', `UPDATE dim_business_services SET operational_status = 'active', name = 'Renamed'
      WHERE service_id = 'bs-co1-retired'`);

    await seedBusinessServices(pg, spec);

    expect(await rows()).toEqual(EXPECTED);
  });

  it.each([
    ['an unmarked service in the same organization', ORG_A, null],
    ['an unmarked service with other metadata in the same organization', ORG_A, '{"owner": "platform"}'],
    ['an unmarked service in another organization', ORG_B, null],
    ["this seed's fixture in another organization", ORG_B, '{"tenant_fixture": true}'],
  ])('refuses %s and leaves it untouched', async (_label, org, metadata) => {
    await insertForeign('bs-co1-retired', org, metadata);

    await expect(seedBusinessServices(pg, spec)).rejects.toThrow(
      "business service bs-co1-retired already exists and is not this seed's fixture in that organization; refusing to modify it"
    );
    const [untouched] = (await rows()).filter(r => r['service_id'] === 'bs-co1-retired');
    expect(untouched).toEqual({
      service_id: 'bs-co1-retired', organization_id: org, operational_status: 'active', name: 'Real service',
      metadata: metadata === null ? null : JSON.parse(metadata),
    });
  });
});

/**
 * The CLI as a real process (TypeScript sources via fixtures/ts-source-register.cjs).
 * A loopback TCP listener records every connection attempt; the api-server's
 * own POSTGRES_* / NEO4J_* / REDIS_* variables all point at it, so any use of
 * them (or the @cmdb/database barrel's import-time Redis connection) shows up.
 */
describe('CLI process', () => {
  const SCRIPT = join(__dirname, '../seed-tenant-fixture.ts');
  const REGISTER = join(__dirname, 'fixtures/ts-source-register.cjs');
  let recorder: Server;
  let port = 0;
  let connections = 0;

  beforeAll(async () => {
    recorder = createServer(socket => {
      connections++;
      socket.destroy();
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    recorder.listen(0, '127.0.0.1', () => resolve());
    await promise;
    port = (recorder.address() as AddressInfo).port;
  });

  afterAll(() => {
    recorder.close();
  });

  beforeEach(() => {
    connections = 0;
  });

  function run(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const { promise, resolve } = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
    const child = spawn(process.execPath, ['-r', REGISTER, SCRIPT, ...argv()], {
      env: {
        PATH: process.env.PATH ?? '',
        POSTGRES_HOST: '127.0.0.1', POSTGRES_PORT: String(port), POSTGRES_DB: 'prod', POSTGRES_USER: 'u', POSTGRES_PASSWORD: 'p',
        NEO4J_URI: `bolt://127.0.0.1:${port}`, NEO4J_USERNAME: 'n', NEO4J_PASSWORD: 'p',
        REDIS_HOST: '127.0.0.1', REDIS_PORT: String(port),
        ...PASSWORDS,
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
    return promise;
  }

  it('keeps stdout empty, sends logs to stderr, and touches only the CMDB_SEED_* endpoint', async () => {
    // CMDB_SEED_POSTGRES_PORT=1 on loopback: nothing listens, so the seed fails after logging.
    const { code, stdout, stderr } = await run({ ...TARGET_ENV, CMDB_SEED_POSTGRES_PORT: '1' });

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('PostgreSQL client initialized WITHOUT SSL'); // a winston log, rerouted
    expect(stderr).toContain('seed-tenant-fixture: connect ECONNREFUSED 127.0.0.1:1');
    expect(stderr).not.toMatch(/pg-secret-value|neo4j-secret-value|svc-password-1234|noorg-password-5678/);
    expect(connections).toBe(0);
  }, 30000);

  it('refuses a non-loopback endpoint before constructing any client', async () => {
    const { code, stdout, stderr } = await run({
      ...TARGET_ENV, CMDB_SEED_POSTGRES_PORT: String(port), CMDB_SEED_NEO4J_URI: 'bolt://neo4j.internal:7687',
    });

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('seed-tenant-fixture: CMDB_SEED_NEO4J_URI host must be loopback');
    expect(stderr).not.toContain('PostgreSQL client initialized');
    expect(connections).toBe(0);
  }, 30000);

  it('refuses a loopback neo4j:// routing URI before any client or driver exists', async () => {
    // Both endpoints point at the recorder: any client or routing driver would register a connection.
    const { code, stdout, stderr } = await run({
      ...TARGET_ENV, CMDB_SEED_POSTGRES_PORT: String(port), CMDB_SEED_NEO4J_URI: `neo4j://localhost:${port}`,
    });

    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('seed-tenant-fixture: CMDB_SEED_NEO4J_URI must be a direct bolt:// URI');
    expect(stderr).not.toContain('PostgreSQL client initialized');
    expect(connections).toBe(0);
  }, 30000);
});
