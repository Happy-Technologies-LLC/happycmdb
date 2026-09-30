// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant fixture seed (CO-1 acceptance runner). SCRATCH DATABASES ONLY.
 *
 * Against a loopback PostgreSQL and Neo4j named by dedicated CMDB_SEED_*
 * variables (never the api-server's own POSTGRES_* / NEO4J_* settings), this:
 *   1. claims both stores as tenant-fixture scratch stores (marker table / node);
 *   2. runs the PostgreSQL migrations (packages/database/src/postgres/migrations);
 *   3. upserts three business services: an active and an inactive one owned by
 *      organization A, and an active one owned by another organization;
 *   4. upserts two enabled viewer users in Neo4j: one whose organizationId is
 *      organization A, and one with no organization.
 *
 * Fail-closed target guard, checked before anything is written:
 *   - `--target scratch` is required, and NODE_ENV=production is refused;
 *   - both hosts must be loopback (127.0.0.1, ::1, localhost), and Neo4j must
 *     be a direct bolt:// URI (a routing neo4j:// driver follows server-advertised
 *     addresses the loopback check cannot see);
 *   - each store must be empty or already carry this seed's marker: a
 *     PostgreSQL database with tables but no cmdb.tenant_fixture_marker, or a
 *     Neo4j graph with nodes but no :TenantFixtureMarker, is refused.
 * Records: only services (metadata.tenant_fixture = true) and users
 * (_tenantFixture = true) that this seed created, in the same organization,
 * are ever modified. Any other existing record with a fixture id or username
 * is refused and left untouched. The internal organization
 * 00000000-0000-0000-0000-000000000000 is refused for both organizations.
 *
 * Tokens are not minted here: callers log in through POST /api/v1/auth/login.
 * Passwords are read from the environment (never argv, which other local users
 * can see), stored only as bcrypt hashes, and never printed. stdout carries
 * exactly one JSON line; every log line goes to stderr.
 *
 * The api-server image build does not compile it (tsconfig.json excludes
 * src/scripts), but the runtime image still carries this source and a
 * TypeScript toolchain, so the guards above are what protect a real database.
 * Build it with `npm run build:tenant-fixture --workspace=packages/api-server`
 * (tsconfig.scripts.json), then:
 *   CMDB_SEED_POSTGRES_HOST=127.0.0.1 CMDB_SEED_POSTGRES_PORT=... CMDB_SEED_POSTGRES_DB=... \
 *   CMDB_SEED_POSTGRES_USER=... CMDB_SEED_POSTGRES_PASSWORD=... \
 *   CMDB_SEED_NEO4J_URI=bolt://127.0.0.1:7687 CMDB_SEED_NEO4J_USERNAME=... CMDB_SEED_NEO4J_PASSWORD=... \
 *   CMDB_SEED_SERVICE_USER_PASSWORD=... CMDB_SEED_NO_ORG_USER_PASSWORD=... \
 *   node packages/api-server/dist/tenant-fixture/api-server/src/scripts/seed-tenant-fixture.js --target scratch \
 *     --organization-id <uuid> --service-id bs-... --inactive-service-id bs-... \
 *     --other-organization-id <uuid> --other-service-id bs-... \
 *     --service-user <name> --no-org-user <name>
 */

import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

// Deliberately not the @cmdb/database barrel: importing it opens a BullMQ Redis
// connection (REDIS_HOST, an endpoint this seed must not touch) at load time.
// These modules open nothing until a client is constructed.
import { Neo4jClient } from '../../../database/src/neo4j/client';
import { PostgresClient } from '../../../database/src/postgres/client';
import { getMigrationStatus, runMigrations } from '../../../database/src/postgres/migrator';
import { PasswordService } from '../auth/password.service';

/** Same shape the api-server accepts as an organization claim (auth.middleware.ts). */
const ORGANIZATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Migration 008 backfills every legacy service into it; fixtures must never touch it. */
const INTERNAL_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000000';
/** business-service.routes.ts create schema; dim_business_services.service_id is VARCHAR(50). */
const SERVICE_ID_RE = /^bs-[a-z0-9-]{1,47}$/;
/** validation/schemas.ts authSchemas._login: alphanum, 3-30 chars; password min 8. */
const USERNAME_RE = /^[A-Za-z0-9]{3,30}$/;
const MIN_PASSWORD_LENGTH = 8;
/** config.schema.ts auth.bcrypt.rounds default. */
const BCRYPT_ROUNDS = 12;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
/** Marks a service row as created by this seed (no schema change needed). */
const SERVICE_MARKER = '{"tenant_fixture": true}';

/**
 * packages/database/src/postgres/migrations, found by walking up from this
 * file, so it resolves from src/scripts (tests) and from the compiled output.
 */
export const MIGRATIONS_DIR = ((): string => {
  for (let dir = __dirname; dirname(dir) !== dir; dir = dirname(dir)) {
    const candidate = join(dir, 'database/src/postgres/migrations');
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('packages/database/src/postgres/migrations not found above seed-tenant-fixture');
})();

export interface TenantFixtureSpec {
  organizationId: string;
  serviceId: string;
  inactiveServiceId: string;
  otherOrganizationId: string;
  otherServiceId: string;
  serviceUser: { username: string; password: string };
  noOrgUser: { username: string; password: string };
}

export interface TenantFixtureTarget {
  postgres: { host: string; port: number; database: string; user: string; password: string };
  neo4j: { uri: string; username: string; password: string };
}

interface SeededService {
  service_id: string;
  organization_id: string;
  operational_status: 'active' | 'inactive';
}

interface SeededUser {
  username: string;
  organization_id: string | null;
  role: 'viewer';
}

export interface TenantFixtureSummary {
  migrations_applied: number;
  services: SeededService[];
  users: SeededUser[];
}

/** Minimal Postgres surface this module needs (PostgresClient satisfies it). */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Minimal Neo4j surface this module needs (Neo4jClient satisfies it). */
export interface GraphClient {
  getSession(): {
    run(query: string, params?: Record<string, unknown>): Promise<{ records: Array<{ get(key: string): unknown }> }>;
    close(): Promise<void>;
  };
}

function flag(argv: readonly string[], name: string): string {
  const index = argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} must be set`);
  }
  return value;
}

/** Parses and validates the CLI arguments and password environment. Throws on anything invalid. */
export function parseSpec(argv: readonly string[], env: NodeJS.ProcessEnv): TenantFixtureSpec {
  const known = new Set([
    '--target', '--organization-id', '--service-id', '--inactive-service-id', '--other-organization-id',
    '--other-service-id', '--service-user', '--no-org-user',
  ]);
  // Strict `--flag value` pairs: unknown or repeated flags are errors.
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]!;
    if (!known.has(name)) {
      throw new Error(`unknown argument ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) {
      throw new Error(`${name} given more than once`);
    }
    seen.add(name);
  }
  if (flag(argv, 'target') !== 'scratch') {
    throw new Error('--target must be "scratch": this seed only writes to disposable scratch databases');
  }

  const spec: TenantFixtureSpec = {
    organizationId: flag(argv, 'organization-id').toLowerCase(),
    serviceId: flag(argv, 'service-id'),
    inactiveServiceId: flag(argv, 'inactive-service-id'),
    otherOrganizationId: flag(argv, 'other-organization-id').toLowerCase(),
    otherServiceId: flag(argv, 'other-service-id'),
    serviceUser: { username: flag(argv, 'service-user'), password: requireEnv(env, 'CMDB_SEED_SERVICE_USER_PASSWORD') },
    noOrgUser: { username: flag(argv, 'no-org-user'), password: requireEnv(env, 'CMDB_SEED_NO_ORG_USER_PASSWORD') },
  };

  for (const [name, id] of [['organization-id', spec.organizationId], ['other-organization-id', spec.otherOrganizationId]]) {
    if (!ORGANIZATION_ID_RE.test(id!)) {
      throw new Error(`--${name} must be a UUID`);
    }
    if (id === INTERNAL_ORGANIZATION_ID) {
      throw new Error(`--${name} must not be the internal organization ${INTERNAL_ORGANIZATION_ID}`);
    }
  }
  if (spec.organizationId === spec.otherOrganizationId) {
    throw new Error('--organization-id and --other-organization-id must differ');
  }
  const serviceIds = [spec.serviceId, spec.inactiveServiceId, spec.otherServiceId];
  for (const id of serviceIds) {
    if (!SERVICE_ID_RE.test(id)) {
      throw new Error(`service id ${JSON.stringify(id)} must match ${SERVICE_ID_RE}`);
    }
  }
  if (new Set(serviceIds).size !== serviceIds.length) {
    throw new Error('the three service ids must differ');
  }
  for (const user of [spec.serviceUser, spec.noOrgUser]) {
    if (!USERNAME_RE.test(user.username)) {
      throw new Error(`username ${JSON.stringify(user.username)} must match ${USERNAME_RE}`);
    }
    if (user.password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`the password for ${user.username} must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  }
  if (spec.serviceUser.username.toLowerCase() === spec.noOrgUser.username.toLowerCase()) {
    throw new Error('--service-user and --no-org-user must differ');
  }
  return spec;
}

/**
 * Reads the dedicated CMDB_SEED_* connection settings and refuses anything
 * that is not a loopback, non-production target. Nothing connects before this.
 */
export function parseTarget(env: NodeJS.ProcessEnv): TenantFixtureTarget {
  if (env['NODE_ENV'] === 'production') {
    throw new Error('refusing to run with NODE_ENV=production');
  }
  const host = requireEnv(env, 'CMDB_SEED_POSTGRES_HOST');
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`CMDB_SEED_POSTGRES_HOST must be loopback (127.0.0.1, ::1, localhost), got ${JSON.stringify(host)}`);
  }
  const port = Number(requireEnv(env, 'CMDB_SEED_POSTGRES_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('CMDB_SEED_POSTGRES_PORT must be a port number');
  }

  // Direct bolt:// only. A routing scheme (neo4j://, neo4j+s://, ...) makes the
  // driver connect to whatever reader/writer addresses the server advertises,
  // which this loopback check never sees. Encrypted variants are pointless on
  // loopback. The URI must be exactly bolt://<loopback host>[:port].
  const uri = requireEnv(env, 'CMDB_SEED_NEO4J_URI');
  let neo4jUrl: URL;
  try {
    neo4jUrl = new URL(uri);
  } catch {
    throw new Error('CMDB_SEED_NEO4J_URI must be a direct bolt:// URI');
  }
  if (neo4jUrl.protocol !== 'bolt:') {
    throw new Error(
      `CMDB_SEED_NEO4J_URI must be a direct bolt:// URI (routing schemes such as neo4j:// can redirect to non-loopback servers), got ${JSON.stringify(neo4jUrl.protocol)}`
    );
  }
  if (neo4jUrl.username !== '' || neo4jUrl.password !== '' || neo4jUrl.search !== '' || neo4jUrl.hash !== ''
    || (neo4jUrl.pathname !== '' && neo4jUrl.pathname !== '/')) {
    throw new Error('CMDB_SEED_NEO4J_URI must be exactly bolt://<host>[:port], with no credentials, path, query or fragment');
  }
  if (!LOOPBACK_HOSTS.has(neo4jUrl.hostname)) {
    throw new Error(`CMDB_SEED_NEO4J_URI host must be loopback (127.0.0.1, ::1, localhost), got ${JSON.stringify(neo4jUrl.hostname)}`);
  }

  return {
    postgres: {
      host,
      port,
      database: requireEnv(env, 'CMDB_SEED_POSTGRES_DB'),
      user: requireEnv(env, 'CMDB_SEED_POSTGRES_USER'),
      password: requireEnv(env, 'CMDB_SEED_POSTGRES_PASSWORD'),
    },
    neo4j: {
      uri,
      username: requireEnv(env, 'CMDB_SEED_NEO4J_USERNAME'),
      password: requireEnv(env, 'CMDB_SEED_NEO4J_PASSWORD'),
    },
  };
}

/**
 * 'fixture' (marker present), 'empty' (no user relations) or 'foreign'
 * (user relations but no marker: not a scratch database this seed may write
 * to). Relations owned by an extension do not count: a fresh database created
 * from a TimescaleDB template already holds the extension's catalog tables.
 */
export async function inspectPostgres(pg: SqlClient): Promise<'fixture' | 'empty' | 'foreign'> {
  const { rows } = await pg.query(
    `SELECT to_regclass('cmdb.tenant_fixture_marker') IS NOT NULL AS marked,
       (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND n.nspname NOT LIKE 'pg\\_toast%'
           AND NOT EXISTS (
             SELECT 1 FROM pg_depend d
             WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
           )) AS tables`
  );
  if (rows[0]!['marked'] === true) {
    return 'fixture';
  }
  return rows[0]!['tables'] === 0 ? 'empty' : 'foreign';
}

/** Same three states for the Neo4j graph, keyed on the :TenantFixtureMarker node. */
export async function inspectGraph(graph: GraphClient): Promise<'fixture' | 'empty' | 'foreign'> {
  const session = graph.getSession();
  try {
    const { records } = await session.run(
      `RETURN EXISTS { MATCH (m:TenantFixtureMarker) } AS marked,
              EXISTS { MATCH (n) WHERE NOT n:TenantFixtureMarker } AS used`
    );
    if (records[0]!.get('marked') === true) {
      return 'fixture';
    }
    return records[0]!.get('used') === true ? 'foreign' : 'empty';
  } finally {
    await session.close();
  }
}

/**
 * Upserts the three fixture services in dim_business_services (migration 008
 * must have run). Only rows this seed created (metadata.tenant_fixture) in the
 * same organization are updated; any other existing row is left untouched and
 * reported as an error.
 */
export async function seedBusinessServices(pg: SqlClient, spec: TenantFixtureSpec): Promise<SeededService[]> {
  const services: SeededService[] = [
    { service_id: spec.serviceId, organization_id: spec.organizationId, operational_status: 'active' },
    { service_id: spec.inactiveServiceId, organization_id: spec.organizationId, operational_status: 'inactive' },
    { service_id: spec.otherServiceId, organization_id: spec.otherOrganizationId, operational_status: 'active' },
  ];
  for (const service of services) {
    // The conditional DO UPDATE returns no row unless the existing service is
    // one of this seed's fixtures in the same organization.
    const result = await pg.query(
      `INSERT INTO dim_business_services (
         service_id, name, description, service_classification, tbm_tower,
         business_criticality, operational_status, organization_id, metadata
       ) VALUES ($1, $2, 'Tenant fixture seeded for the CO-1 acceptance runner', 'application', 'application',
         'medium', $3, $4, $5::jsonb)
       ON CONFLICT (service_id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         service_classification = EXCLUDED.service_classification,
         tbm_tower = EXCLUDED.tbm_tower,
         business_criticality = EXCLUDED.business_criticality,
         operational_status = EXCLUDED.operational_status,
         updated_at = NOW()
       WHERE dim_business_services.organization_id = EXCLUDED.organization_id
         AND dim_business_services.metadata @> $5::jsonb
       RETURNING service_id`,
      [service.service_id, `Fixture ${service.service_id}`, service.operational_status, service.organization_id, SERVICE_MARKER]
    );
    if (result.rows.length === 0) {
      throw new Error(
        `business service ${service.service_id} already exists and is not this seed's fixture in that organization; refusing to modify it`
      );
    }
  }
  return services;
}

/**
 * Upserts the two fixture users as enabled viewers. Matches both the
 * underscored and the legacy property names, exactly like
 * Neo4jAuthRepository.findUserByUsername, so login finds the seeded node. An
 * existing node is only updated when this seed created it (_tenantFixture) in
 * the same organization.
 */
export async function seedUsers(
  graph: GraphClient,
  spec: TenantFixtureSpec,
  hash: (password: string) => Promise<string>
): Promise<SeededUser[]> {
  const users: SeededUser[] = [
    { username: spec.serviceUser.username, organization_id: spec.organizationId, role: 'viewer' },
    { username: spec.noOrgUser.username, organization_id: null, role: 'viewer' },
  ];
  const passwords = [spec.serviceUser.password, spec.noOrgUser.password];

  for (const [index, user] of users.entries()) {
    const session = graph.getSession();
    try {
      const existing = await session.run(
        `MATCH (u:User) WHERE u._username = $username OR u.username = $username
         RETURN coalesce(u._organizationId, u.organizationId) AS organizationId, u._tenantFixture = true AS fixture`,
        { username: user.username }
      );
      if (existing.records.length > 1) {
        throw new Error(`more than one user is named ${user.username}; refusing to choose`);
      }
      const found = existing.records[0];
      if (found !== undefined && found.get('fixture') !== true) {
        throw new Error(`user ${user.username} already exists and was not created by this seed; refusing to modify it`);
      }
      if (found !== undefined && (found.get('organizationId') ?? null) !== user.organization_id) {
        throw new Error(`user ${user.username} already exists in a different organization; refusing to move it`);
      }

      // Setting _organizationId to null removes it (the no-org user).
      const target = found === undefined
        ? 'CREATE (u:User {_id: $id, _createdAt: datetime(), _tenantFixture: true})'
        : 'MATCH (u:User) WHERE (u._username = $username OR u.username = $username) AND u._tenantFixture = true';
      await session.run(
        `${target}
         SET u._username = $username,
             u._email = $username + '@tenant-fixture.invalid',
             u._passwordHash = $passwordHash,
             u._role = $role,
             u._enabled = true,
             u._organizationId = $organizationId,
             u._updatedAt = datetime()`,
        {
          username: user.username,
          id: randomUUID(),
          passwordHash: await hash(passwords[index]!),
          role: user.role,
          organizationId: user.organization_id,
        }
      );
    } finally {
      await session.close();
    }
  }
  return users;
}

/**
 * Verifies both stores before writing anything, claims them with the
 * fixture markers, migrates, and seeds.
 */
export async function seedTenantFixture(
  deps: { postgres: PostgresClient; neo4j: GraphClient; hash: (password: string) => Promise<string> },
  spec: TenantFixtureSpec
): Promise<TenantFixtureSummary> {
  if (await inspectPostgres(deps.postgres) === 'foreign') {
    throw new Error('the PostgreSQL database has tables but no tenant fixture marker; refusing to write to a non-scratch database');
  }
  if (await inspectGraph(deps.neo4j) === 'foreign') {
    throw new Error('the Neo4j graph has nodes but no tenant fixture marker; refusing to write to a non-scratch graph');
  }

  await deps.postgres.query('CREATE SCHEMA IF NOT EXISTS cmdb');
  await deps.postgres.query(
    'CREATE TABLE IF NOT EXISTS cmdb.tenant_fixture_marker (created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
  );
  const session = deps.neo4j.getSession();
  try {
    await session.run("MERGE (:TenantFixtureMarker {id: 'cmdb-tenant-fixture'})");
  } finally {
    await session.close();
  }

  await runMigrations(deps.postgres, MIGRATIONS_DIR);
  const migrations = await getMigrationStatus(deps.postgres, MIGRATIONS_DIR);
  const services = await seedBusinessServices(deps.postgres, spec);
  const users = await seedUsers(deps.neo4j, spec, deps.hash);
  return { migrations_applied: migrations.filter(m => m._applied).length, services, users };
}

/**
 * CLI entry: validates arguments and target, seeds, prints the summary, and
 * returns the exit code. Errors go to stderr without connection details.
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: { stdout: (line: string) => void; stderr: (line: string) => void }
): Promise<number> {
  let postgres: PostgresClient | undefined;
  let neo4j: Neo4jClient | undefined;
  try {
    const spec = parseSpec(argv, env);
    const target = parseTarget(env);
    postgres = new PostgresClient({
      _host: target.postgres.host,
      _port: target.postgres.port,
      _database: target.postgres.database,
      _user: target.postgres.user,
      _password: target.postgres.password,
    });
    neo4j = new Neo4jClient(target.neo4j.uri, target.neo4j.username, target.neo4j.password);
    const passwords = new PasswordService({ rounds: BCRYPT_ROUNDS });
    const summary = await seedTenantFixture(
      { postgres, neo4j, hash: password => passwords.hash(password) },
      spec
    );
    io.stdout(JSON.stringify(summary));
    return 0;
  } catch (error) {
    io.stderr(`seed-tenant-fixture: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await postgres?.close();
    await neo4j?.close();
  }
}

if (require.main === module) {
  // stdout is reserved for the JSON summary. Everything else that writes to
  // stdout (the shared winston Console transport, libraries) goes to stderr.
  const writeSummary = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);
  // PostgresClient / Neo4jClient also read the api-server's own TLS toggles
  // from process.env. The seed's connections are defined only by CMDB_SEED_*,
  // so drop those before any client exists.
  for (const name of ['POSTGRES_SSL_MODE', 'POSTGRES_SSL_ENABLED', 'NEO4J_SSL_ENABLED', 'NEO4J_ENCRYPTION']) {
    delete process.env[name];
  }
  // Explicit exit so a lingering driver socket cannot keep the process alive.
  void main(process.argv.slice(2), process.env, {
    stdout: line => writeSummary(`${line}\n`),
    stderr: line => process.stderr.write(`${line}\n`),
  }).then(code => process.exit(code));
}
