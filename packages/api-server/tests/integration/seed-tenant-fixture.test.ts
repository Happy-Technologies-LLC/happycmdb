// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant fixture seed against the integration harness's real Neo4j 5.15 and
 * PostgreSQL/TimescaleDB containers.
 *
 * The seed runs in a fresh scratch database, so the real migrator applies
 * every migration from scratch. The harness Neo4j is shared with other suites
 * (it has nodes), so the seed first refuses it; the suite then marks it as a
 * tenant-fixture graph, standing in for the empty graph the CO-1 runner
 * provisions. The seed is configured only through CMDB_SEED_* variables. The
 * api-server's own auth and business-service routes then serve the scratch
 * database, and the seeded users log in through POST /api/v1/auth/login.
 */

import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { readdirSync } from 'fs';
import { join } from 'path';
import * as bcrypt from 'bcrypt';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { Client } from 'pg';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { main, MIGRATIONS_DIR } from '../../src/scripts/seed-tenant-fixture';

const suffix = randomBytes(4).toString('hex');
const SCRATCH_DB = `cmdb_seed_${suffix}`;
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const SERVICE = `bs-seed-${suffix}-active`;
const INACTIVE = `bs-seed-${suffix}-inactive`;
const FOREIGN = `bs-seed-${suffix}-foreign`;
const SERVICE_USER = `seedhive${suffix}`;
const NO_ORG_USER = `seednoorg${suffix}`;
const ADMIN_USER = `seedadmin${suffix}`;
// Random per run; never literals.
const PASSWORD_1 = randomBytes(12).toString('hex');
const PASSWORD_2 = randomBytes(12).toString('hex');
const NO_ORG_PASSWORD = randomBytes(12).toString('hex');
const NOT_FOUND = { success: false, error: 'Business service not found' };
const SCRIPT = join(__dirname, '../../src/scripts/seed-tenant-fixture.ts');
const REGISTER = join(__dirname, '../../src/scripts/__tests__/fixtures/ts-source-register.cjs');

const ARGS = [
  '--target', 'scratch',
  '--organization-id', ORG_A, '--service-id', SERVICE, '--inactive-service-id', INACTIVE,
  '--other-organization-id', ORG_B, '--other-service-id', FOREIGN,
  '--service-user', SERVICE_USER, '--no-org-user', NO_ORG_USER,
];

const harnessDb = process.env.POSTGRES_DB!;
const admin = (database = harnessDb) => new Client({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database,
});

/** The seed's whole environment: dedicated CMDB_SEED_* names only. */
function seedEnv(serviceUserPassword: string, database = SCRATCH_DB): Record<string, string> {
  return {
    NODE_ENV: 'test',
    CMDB_SEED_POSTGRES_HOST: process.env.POSTGRES_HOST!,
    CMDB_SEED_POSTGRES_PORT: process.env.POSTGRES_PORT!,
    CMDB_SEED_POSTGRES_DB: database,
    CMDB_SEED_POSTGRES_USER: process.env.POSTGRES_USER!,
    CMDB_SEED_POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD!,
    CMDB_SEED_NEO4J_URI: process.env.NEO4J_URI!,
    CMDB_SEED_NEO4J_USERNAME: process.env.NEO4J_USERNAME!,
    CMDB_SEED_NEO4J_PASSWORD: process.env.NEO4J_PASSWORD!,
    CMDB_SEED_SERVICE_USER_PASSWORD: serviceUserPassword,
    CMDB_SEED_NO_ORG_USER_PASSWORD: NO_ORG_PASSWORD,
  };
}

function expectNoSecrets(output: string): void {
  for (const secret of [PASSWORD_1, PASSWORD_2, NO_ORG_PASSWORD, process.env.POSTGRES_PASSWORD!, process.env.NEO4J_PASSWORD!]) {
    expect(output).not.toContain(secret);
  }
}

async function seed(argv: string[], env: Record<string, string>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(argv, env, { stdout: l => stdout.push(l), stderr: l => stderr.push(l) });
  expectNoSecrets([...stdout, ...stderr].join('\n'));
  return { code, stdout, stderr };
}

/** The CLI as a real process: real stdout/stderr, TypeScript sources via the test register. */
function seedProcess(env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
  const child = spawn(process.execPath, ['-r', REGISTER, SCRIPT, ...ARGS], {
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('close', code => resolve({ code, stdout, stderr }));
  return promise;
}

async function graph<T>(query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const session = getNeo4jClient().getSession();
  try {
    const result = await session.run(query, params);
    return result.records.map(r => r.toObject() as T);
  } finally {
    await session.close();
  }
}

function users(names: string[]) {
  return graph<Record<string, unknown>>(
    `MATCH (u:User) WHERE u._username IN $names OR u.username IN $names
     RETURN u._username AS username, u._passwordHash AS hash, u._role AS role, u._enabled AS enabled,
            u._organizationId AS org, u._tenantFixture AS fixture ORDER BY username`,
    { names }
  );
}

/**
 * Every user relation in `database` (not extension-owned: the TimescaleDB
 * template gives each new database the extension's catalog), e.g. to prove a
 * refused run wrote nothing.
 */
async function scratchTables(database: string): Promise<string[]> {
  const pg = admin(database);
  await pg.connect();
  try {
    const { rows } = await pg.query(
      `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d
           WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
       ORDER BY 1`
    );
    return rows.map(r => r.name as string);
  } finally {
    await pg.end();
  }
}

let app: Express;

beforeAll(async () => {
  const client = admin();
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${SCRATCH_DB}`);
  } finally {
    await client.end();
  }
  await graph('MATCH (m:TenantFixtureMarker) DETACH DELETE m');
  // Other suites may have cleaned up after themselves: guarantee the shared graph is non-empty.
  await graph('CREATE (:SeedTestSentinel {id: $id})', { id: suffix });

  // Dynamic imports on purpose: the route modules create their Postgres
  // clients at load (BusinessServiceController, Neo4jAuthRepository), so
  // POSTGRES_DB must name the scratch database first. Login is rate limited per IP.
  process.env.POSTGRES_DB = SCRATCH_DB;
  process.env.RATE_LIMIT_AUTH_MAX = '1000';
  const { authRoutes } = await import('../../src/rest/routes/auth.routes');
  const { getAuthMiddleware } = await import('../../src/auth/auth-bootstrap');
  const { businessServiceRoutes } = await import('../../src/rest/routes/business-service.routes');
  app = express();
  app.use(express.json());
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1', getAuthMiddleware().authenticate());
  app.use('/api/v1/business-services', businessServiceRoutes);
}, 120000);

afterAll(async () => {
  await graph('MATCH (u:User) WHERE u._username IN $names OR u.username IN $names DETACH DELETE u', {
    names: [SERVICE_USER, NO_ORG_USER, ADMIN_USER],
  });
  await graph('MATCH (m:TenantFixtureMarker) DETACH DELETE m');
  await graph('MATCH (s:SeedTestSentinel {id: $id}) DETACH DELETE s', { id: suffix });
  await getPostgresClient().close();
  await getNeo4jClient().close();
  process.env.POSTGRES_DB = harnessDb;
  delete process.env.RATE_LIMIT_AUTH_MAX;

  const client = admin();
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  } finally {
    await client.end();
  }
});

async function login(username: string, password: string): Promise<request.Response> {
  return request(app).post('/api/v1/auth/login').send({ username, password });
}

describe('seed-tenant-fixture against the integration harness', () => {
  let firstSummary: unknown;

  it('refuses a non-scratch PostgreSQL database (tables, no marker) and writes nothing', async () => {
    const before = await scratchTables(harnessDb);
    const { code, stdout, stderr } = await seed(ARGS, seedEnv(PASSWORD_1, harnessDb));

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      'seed-tenant-fixture: the PostgreSQL database has tables but no tenant fixture marker; refusing to write to a non-scratch database',
    ]);
    expect(await scratchTables(harnessDb)).toEqual(before);
  });

  it('refuses a non-scratch Neo4j graph (nodes, no marker) before writing to either store', async () => {
    const { code, stdout, stderr } = await seed(ARGS, seedEnv(PASSWORD_1));

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      'seed-tenant-fixture: the Neo4j graph has nodes but no tenant fixture marker; refusing to write to a non-scratch graph',
    ]);
    expect(await scratchTables(SCRATCH_DB)).toEqual([]);
    expect(await graph('MATCH (m:TenantFixtureMarker) RETURN m')).toEqual([]);
    expect(await users([SERVICE_USER, NO_ORG_USER])).toEqual([]);
  });

  it('as a real process: migrates from scratch, seeds, and prints exactly one JSON document on stdout', async () => {
    // Stands in for the empty graph the runner provisions (the harness graph is shared).
    await graph("MERGE (:TenantFixtureMarker {id: 'cmdb-tenant-fixture'})");

    const { code, stdout, stderr } = await seedProcess(seedEnv(PASSWORD_1));
    expectNoSecrets(stdout + stderr);
    expect(code).toBe(0);
    expect(stdout.endsWith('\n')).toBe(true);
    expect(stdout.trimEnd().split('\n')).toHaveLength(1);

    const migrationFiles = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    firstSummary = JSON.parse(stdout);
    expect(firstSummary).toEqual({
      migrations_applied: migrationFiles.length,
      services: [
        { service_id: SERVICE, organization_id: ORG_A, operational_status: 'active' },
        { service_id: INACTIVE, organization_id: ORG_A, operational_status: 'inactive' },
        { service_id: FOREIGN, organization_id: ORG_B, operational_status: 'active' },
      ],
      users: [
        { username: SERVICE_USER, organization_id: ORG_A, role: 'viewer' },
        { username: NO_ORG_USER, organization_id: null, role: 'viewer' },
      ],
    });

    const pg = getPostgresClient();
    const applied = await pg.query('SELECT migration_name FROM cmdb.schema_migrations ORDER BY migration_name');
    expect(applied.rows.map(r => r.migration_name)).toEqual(migrationFiles);
    expect(await scratchTables(SCRATCH_DB)).toContain('cmdb.tenant_fixture_marker');

    const seededUsers = await users([SERVICE_USER, NO_ORG_USER]);
    // ORDER BY username: seedhive… < seednoorg….
    expect(seededUsers).toEqual([
      { username: SERVICE_USER, hash: expect.stringMatching(/^\$2b\$12\$/), role: 'viewer', enabled: true, org: ORG_A, fixture: true },
      { username: NO_ORG_USER, hash: expect.stringMatching(/^\$2b\$12\$/), role: 'viewer', enabled: true, org: null, fixture: true },
    ]);
    expect(await bcrypt.compare(PASSWORD_1, seededUsers[0]!.hash as string)).toBe(true);
  }, 120000);

  it('is idempotent: a second run converges to the same state and rotates the password', async () => {
    const pg = getPostgresClient();
    await pg.query(`UPDATE dim_business_services SET operational_status = 'active' WHERE service_id = $1`, [INACTIVE]);

    const { code, stdout } = await seed(ARGS, seedEnv(PASSWORD_2));
    expect(code).toBe(0);
    expect(JSON.parse(stdout[0]!)).toEqual(firstSummary);

    const services = await pg.query(
      'SELECT service_id, organization_id, operational_status FROM dim_business_services WHERE service_id = ANY($1) ORDER BY service_id',
      [[SERVICE, INACTIVE, FOREIGN]]
    );
    // ORDER BY service_id: …-active < …-foreign < …-inactive.
    expect(services.rows).toEqual([
      { service_id: SERVICE, organization_id: ORG_A, operational_status: 'active' },
      { service_id: FOREIGN, organization_id: ORG_B, operational_status: 'active' },
      { service_id: INACTIVE, organization_id: ORG_A, operational_status: 'inactive' },
    ]);
    expect(await users([SERVICE_USER, NO_ORG_USER])).toHaveLength(2);

    expect((await login(SERVICE_USER, PASSWORD_1)).status).toBe(401);
    expect((await login(SERVICE_USER, PASSWORD_2)).status).toBe(200);
  });

  it('serves the fixture through the real login and org-scoped routes: 200, inactive, 404, 403', async () => {
    const hive = await login(SERVICE_USER, PASSWORD_2);
    const noOrg = await login(NO_ORG_USER, NO_ORG_PASSWORD);
    expect([hive.status, noOrg.status]).toEqual([200, 200]);
    const asHive = { Authorization: `Bearer ${hive.body.data._accessToken}` };
    const asNoOrg = { Authorization: `Bearer ${noOrg.body.data._accessToken}` };

    const own = await request(app).get(`/api/v1/business-services/${SERVICE}`).set(asHive);
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ service_id: SERVICE, organization_id: ORG_A, operational_status: 'active' });

    const inactive = await request(app).get(`/api/v1/business-services/${INACTIVE}`).set(asHive);
    expect(inactive.status).toBe(200);
    expect(inactive.body.data).toMatchObject({ service_id: INACTIVE, operational_status: 'inactive' });

    const foreign = await request(app).get(`/api/v1/business-services/${FOREIGN}`).set(asHive);
    expect([foreign.status, foreign.body]).toEqual([404, NOT_FOUND]);

    const forbidden = await request(app).get(`/api/v1/business-services/${SERVICE}`).set(asNoOrg);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({ _error: 'Forbidden', _message: 'Organization claim required' });
  });

  it('refuses to take over an existing same-organization user it did not create, leaving it untouched', async () => {
    await graph(
      `CREATE (:User {_id: $id, _username: $username, _passwordHash: 'real-admin-hash', _role: 'admin',
        _enabled: false, _organizationId: $org})`,
      { id: `admin-${suffix}`, username: ADMIN_USER, org: ORG_A }
    );

    const argv = [...ARGS];
    argv[argv.indexOf('--service-user') + 1] = ADMIN_USER;
    const { code, stdout, stderr } = await seed(argv, seedEnv(PASSWORD_2));

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      `seed-tenant-fixture: user ${ADMIN_USER} already exists and was not created by this seed; refusing to modify it`,
    ]);
    expect(await users([ADMIN_USER])).toEqual([
      { username: ADMIN_USER, hash: 'real-admin-hash', role: 'admin', enabled: false, org: ORG_A, fixture: null },
    ]);
  });
});
