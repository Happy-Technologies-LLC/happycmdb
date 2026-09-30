// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the tenant fixture seed: CLI validation, and the
 * business-service upsert against PGlite (the dim_business_services CREATE
 * TABLE block from 001_complete_schema.sql, then 008 verbatim).
 *
 * The full script (real migrator, real Neo4j users, login through the API) is
 * exercised by packages/api-server/tests/integration/seed-tenant-fixture.test.ts.
 */

import { fork } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

// Importing @cmdb/database opens a BullMQ Redis connection; nothing here uses it.
jest.mock('@cmdb/database', () => ({}));

import { main, parseSpec, seedBusinessServices, MIGRATIONS_DIR, type TenantFixtureSpec } from '../seed-tenant-fixture';

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

const ORG_A = '00000000-0000-0000-0000-000000000000';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const PASSWORDS = { CMDB_SEED_SERVICE_USER_PASSWORD: 'svc-password-1234', CMDB_SEED_NO_ORG_USER_PASSWORD: 'noorg-password-5678' };
const ARGS: Record<string, string> = {
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

  it.each([
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

describe('main', () => {
  it('fails closed on missing database settings, without echoing any password', async () => {
    const out: string[] = [];
    const code = await main(argv(), { ...PASSWORDS }, { stdout: l => out.push(l), stderr: l => out.push(l) });
    expect(code).toBe(1);
    expect(out).toEqual(['seed-tenant-fixture: POSTGRES_HOST must be set']);
  });
});

describe('seedBusinessServices (PGlite)', () => {
  const spec: TenantFixtureSpec = parseSpec(argv(), PASSWORDS);
  const rows = () => send(
    'query',
    'SELECT service_id, organization_id, operational_status, name FROM dim_business_services ORDER BY service_id'
  );

  beforeEach(async () => {
    await send('exec', 'TRUNCATE dim_business_services CASCADE');
  });

  const EXPECTED = [
    { service_id: 'bs-co1-foreign', organization_id: ORG_B, operational_status: 'active', name: 'Fixture bs-co1-foreign' },
    { service_id: 'bs-co1-fulfillment', organization_id: ORG_A, operational_status: 'active', name: 'Fixture bs-co1-fulfillment' },
    { service_id: 'bs-co1-retired', organization_id: ORG_A, operational_status: 'inactive', name: 'Fixture bs-co1-retired' },
  ];

  it('creates the active and inactive org-A services and the other organization service', async () => {
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

  it('refuses to move an existing service to another organization and leaves it untouched', async () => {
    await send('exec', `INSERT INTO dim_business_services (service_id, name, service_classification, tbm_tower,
      business_criticality, operational_status, organization_id)
      VALUES ('bs-co1-fulfillment', 'Owned by B', 'data', 'data', 'low', 'inactive', '${ORG_B}')`);

    await expect(seedBusinessServices(pg, spec)).rejects.toThrow(
      'business service bs-co1-fulfillment already exists in another organization; refusing to move it'
    );
    expect(await rows()).toEqual([
      { service_id: 'bs-co1-fulfillment', organization_id: ORG_B, operational_status: 'inactive', name: 'Owned by B' },
    ]);
  });
});
