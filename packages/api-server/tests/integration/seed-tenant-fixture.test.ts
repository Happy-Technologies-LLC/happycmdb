// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant fixture seed against the integration harness's real Neo4j 5.15 and
 * PostgreSQL/TimescaleDB containers.
 *
 * The seed runs in a fresh scratch database, so the real migrator applies
 * every migration from scratch (the shared harness database was loaded with
 * psql and has no schema_migrations rows). The api-server's own auth and
 * business-service routes then serve that database, and the seeded users log
 * in through POST /api/v1/auth/login.
 */

import { randomBytes } from 'crypto';
import { readdirSync } from 'fs';
import * as bcrypt from 'bcrypt';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { Client } from 'pg';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { main, MIGRATIONS_DIR } from '../../src/scripts/seed-tenant-fixture';

const suffix = randomBytes(4).toString('hex');
const SCRATCH_DB = `cmdb_seed_${suffix}`;
const ORG_A = '00000000-0000-0000-0000-000000000000';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const SERVICE = `bs-seed-${suffix}-active`;
const INACTIVE = `bs-seed-${suffix}-inactive`;
const FOREIGN = `bs-seed-${suffix}-foreign`;
const SERVICE_USER = `seedhive${suffix}`;
const NO_ORG_USER = `seednoorg${suffix}`;
const CLASH_USER = `seedclash${suffix}`;
// Random per run; never literals.
const PASSWORD_1 = randomBytes(12).toString('hex');
const PASSWORD_2 = randomBytes(12).toString('hex');
const NO_ORG_PASSWORD = randomBytes(12).toString('hex');
const NOT_FOUND = { success: false, error: 'Business service not found' };

const ARGS = [
  '--organization-id', ORG_A, '--service-id', SERVICE, '--inactive-service-id', INACTIVE,
  '--other-organization-id', ORG_B, '--other-service-id', FOREIGN,
  '--service-user', SERVICE_USER, '--no-org-user', NO_ORG_USER,
];

const harnessDb = process.env.POSTGRES_DB!;
const admin = () => new Client({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: harnessDb,
});

async function seed(argv: string[], serviceUserPassword: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await main(
    argv,
    {
      ...process.env,
      POSTGRES_DB: SCRATCH_DB,
      CMDB_SEED_SERVICE_USER_PASSWORD: serviceUserPassword,
      CMDB_SEED_NO_ORG_USER_PASSWORD: NO_ORG_PASSWORD,
    },
    { stdout: l => stdout.push(l), stderr: l => stderr.push(l) }
  );
  const output = [...stdout, ...stderr].join('\n');
  for (const secret of [PASSWORD_1, PASSWORD_2, NO_ORG_PASSWORD, process.env.POSTGRES_PASSWORD!, process.env.NEO4J_PASSWORD!]) {
    expect(output).not.toContain(secret);
  }
  return { code, stdout, stderr };
}

async function users(names: string[]) {
  const session = getNeo4jClient().getSession();
  try {
    const result = await session.run(
      `MATCH (u:User) WHERE u._username IN $names OR u.username IN $names
       RETURN u._username AS username, u._passwordHash AS hash, u._role AS role, u._enabled AS enabled,
              u._organizationId AS org, u.organizationId AS legacyOrg ORDER BY username`,
      { names }
    );
    return result.records.map(r => r.toObject() as Record<string, unknown>);
  } finally {
    await session.close();
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
  const session = getNeo4jClient().getSession();
  try {
    await session.run('MATCH (u:User) WHERE u._username IN $names OR u.username IN $names DETACH DELETE u', {
      names: [SERVICE_USER, NO_ORG_USER, CLASH_USER],
    });
  } finally {
    await session.close();
  }
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

  it('runs every migration from scratch and seeds services and users', async () => {
    const { code, stdout, stderr } = await seed(ARGS, PASSWORD_1);
    expect(stderr).toEqual([]);
    expect(code).toBe(0);

    const migrationFiles = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    firstSummary = JSON.parse(stdout[0]!);
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

    const seededUsers = await users([SERVICE_USER, NO_ORG_USER]);
    // ORDER BY username: seedhive… < seednoorg….
    expect(seededUsers).toEqual([
      { username: SERVICE_USER, hash: expect.stringMatching(/^\$2b\$12\$/), role: 'viewer', enabled: true, org: ORG_A, legacyOrg: null },
      { username: NO_ORG_USER, hash: expect.stringMatching(/^\$2b\$12\$/), role: 'viewer', enabled: true, org: null, legacyOrg: null },
    ]);
    expect(await bcrypt.compare(PASSWORD_1, seededUsers[0]!.hash as string)).toBe(true);
  });

  it('is idempotent: a second run converges to the same state and rotates the password', async () => {
    const pg = getPostgresClient();
    await pg.query(`UPDATE dim_business_services SET operational_status = 'active' WHERE service_id = $1`, [INACTIVE]);

    const { code, stdout } = await seed(ARGS, PASSWORD_2);
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

  it('refuses to move an existing user to another organization and leaves it untouched', async () => {
    const session = getNeo4jClient().getSession();
    try {
      await session.run(
        `CREATE (u:User {_id: $id, _username: $username, _passwordHash: 'x', _role: 'viewer', _enabled: true, _organizationId: $org})`,
        { id: `clash-${suffix}`, username: CLASH_USER, org: ORG_B }
      );
    } finally {
      await session.close();
    }

    const argv = [...ARGS];
    argv[argv.indexOf('--service-user') + 1] = CLASH_USER;
    const { code, stdout, stderr } = await seed(argv, PASSWORD_2);

    expect(code).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      `seed-tenant-fixture: user ${CLASH_USER} already exists in a different organization; refusing to move it`,
    ]);
    expect(await users([CLASH_USER])).toEqual([
      { username: CLASH_USER, hash: 'x', role: 'viewer', enabled: true, org: ORG_B, legacyOrg: null },
    ]);
  });
});
