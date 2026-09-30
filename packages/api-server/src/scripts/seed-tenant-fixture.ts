// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenant fixture seed (CO-1 acceptance runner).
 *
 * Against the PostgreSQL and Neo4j named by the api-server's own environment
 * (POSTGRES_HOST/PORT/DB/USER/PASSWORD, NEO4J_URI/USERNAME/PASSWORD), this:
 *   1. runs the PostgreSQL migrations (packages/database/src/postgres/migrations);
 *   2. upserts three business services: an active and an inactive one owned by
 *      organization A, and an active one owned by another organization;
 *   3. upserts two enabled viewer users in Neo4j: one whose organizationId is
 *      organization A, and one with no organization.
 *
 * Tokens are not minted here: callers log in through POST /api/v1/auth/login.
 * Passwords are read from the environment (never argv, which other local users
 * can see), stored only as bcrypt hashes, and never printed. stdout gets one
 * JSON line naming what was seeded.
 *
 * Re-running converges to the same state (passwords are re-hashed, so they may
 * rotate between runs). It refuses, without writing that record, to move an
 * existing service or user to a different organization.
 *
 * Usage (after `npm run build`):
 *   CMDB_SEED_SERVICE_USER_PASSWORD=... CMDB_SEED_NO_ORG_USER_PASSWORD=... \
 *   node packages/api-server/dist/scripts/seed-tenant-fixture.js \
 *     --organization-id <uuid> --service-id bs-... --inactive-service-id bs-... \
 *     --other-organization-id <uuid> --other-service-id bs-... \
 *     --service-user <name> --no-org-user <name>
 */

import { randomUUID } from 'crypto';
import { resolve } from 'path';

import { getMigrationStatus, runMigrations, Neo4jClient, PostgresClient } from '@cmdb/database';

import { PasswordService } from '../auth/password.service';

/** Same shape the api-server accepts as an organization claim (auth.middleware.ts). */
const ORGANIZATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** business-service.routes.ts create schema; dim_business_services.service_id is VARCHAR(50). */
const SERVICE_ID_RE = /^bs-[a-z0-9-]{1,47}$/;
/** validation/schemas.ts authSchemas._login: alphanum, 3-30 chars; password min 8. */
const USERNAME_RE = /^[A-Za-z0-9]{3,30}$/;
const MIN_PASSWORD_LENGTH = 8;
/** config.schema.ts auth.bcrypt.rounds default. */
const BCRYPT_ROUNDS = 12;

export const MIGRATIONS_DIR = resolve(__dirname, '../../../database/src/postgres/migrations');

export interface TenantFixtureSpec {
  organizationId: string;
  serviceId: string;
  inactiveServiceId: string;
  otherOrganizationId: string;
  otherServiceId: string;
  serviceUser: { username: string; password: string };
  noOrgUser: { username: string; password: string };
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
    run(query: string, params: Record<string, unknown>): Promise<{ records: Array<{ get(key: string): unknown }> }>;
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
    '--organization-id', '--service-id', '--inactive-service-id', '--other-organization-id',
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
 * Upserts the three fixture services in dim_business_services (migration 008
 * must have run). An existing service_id owned by another organization is
 * left untouched and reported as an error.
 */
export async function seedBusinessServices(pg: SqlClient, spec: TenantFixtureSpec): Promise<SeededService[]> {
  const services: SeededService[] = [
    { service_id: spec.serviceId, organization_id: spec.organizationId, operational_status: 'active' },
    { service_id: spec.inactiveServiceId, organization_id: spec.organizationId, operational_status: 'inactive' },
    { service_id: spec.otherServiceId, organization_id: spec.otherOrganizationId, operational_status: 'active' },
  ];
  for (const service of services) {
    // The conditional DO UPDATE returns no row when the existing service
    // belongs to another organization, so it is never re-tenanted.
    const result = await pg.query(
      `INSERT INTO dim_business_services (
         service_id, name, description, service_classification, tbm_tower,
         business_criticality, operational_status, organization_id
       ) VALUES ($1, $2, 'Tenant fixture seeded for the CO-1 acceptance runner', 'application', 'application',
         'medium', $3, $4)
       ON CONFLICT (service_id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         service_classification = EXCLUDED.service_classification,
         tbm_tower = EXCLUDED.tbm_tower,
         business_criticality = EXCLUDED.business_criticality,
         operational_status = EXCLUDED.operational_status,
         updated_at = NOW()
       WHERE dim_business_services.organization_id = EXCLUDED.organization_id
       RETURNING service_id`,
      [service.service_id, `Fixture ${service.service_id}`, service.operational_status, service.organization_id]
    );
    if (result.rows.length === 0) {
      throw new Error(`business service ${service.service_id} already exists in another organization; refusing to move it`);
    }
  }
  return services;
}

/**
 * Upserts the two fixture users as enabled viewers. Matches both the
 * underscored and the legacy property names, exactly like
 * Neo4jAuthRepository.findUserByUsername, so login finds the seeded node.
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
    const passwordHash = await hash(passwords[index]!);
    const session = graph.getSession();
    try {
      const existing = await session.run(
        `MATCH (u:User) WHERE u._username = $username OR u.username = $username
         RETURN coalesce(u._organizationId, u.organizationId) AS organizationId`,
        { username: user.username }
      );
      if (existing.records.length > 1) {
        throw new Error(`more than one user is named ${user.username}; refusing to choose`);
      }
      const current = existing.records[0]?.get('organizationId') ?? null;
      if (existing.records.length === 1 && current !== user.organization_id) {
        throw new Error(`user ${user.username} already exists in a different organization; refusing to move it`);
      }

      // Underscored properties take precedence in Neo4jAuthRepository.mapUserNode;
      // the legacy organizationId is removed so it cannot reappear via coalesce.
      // Setting _organizationId to null removes it (the no-org user).
      const target = existing.records.length === 1
        ? 'MATCH (u:User) WHERE u._username = $username OR u.username = $username'
        : 'CREATE (u:User {_id: $id, _createdAt: datetime()})';
      await session.run(
        `${target}
         SET u._username = $username,
             u._email = $username + '@tenant-fixture.invalid',
             u._passwordHash = $passwordHash,
             u._role = $role,
             u._enabled = true,
             u._organizationId = $organizationId,
             u._updatedAt = datetime()
         REMOVE u.organizationId`,
        {
          username: user.username,
          id: randomUUID(),
          passwordHash,
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

export async function seedTenantFixture(
  deps: { postgres: PostgresClient; neo4j: GraphClient; hash: (password: string) => Promise<string> },
  spec: TenantFixtureSpec
): Promise<TenantFixtureSummary> {
  await runMigrations(deps.postgres, MIGRATIONS_DIR);
  const migrations = await getMigrationStatus(deps.postgres, MIGRATIONS_DIR);
  const services = await seedBusinessServices(deps.postgres, spec);
  const users = await seedUsers(deps.neo4j, spec, deps.hash);
  return { migrations_applied: migrations.filter(m => m._applied).length, services, users };
}

/**
 * CLI entry. Connects with the api-server's database environment (no
 * defaults: every variable must be set), seeds, prints the summary, and
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
    postgres = new PostgresClient({
      _host: requireEnv(env, 'POSTGRES_HOST'),
      _port: Number(requireEnv(env, 'POSTGRES_PORT')),
      _database: requireEnv(env, 'POSTGRES_DB'),
      _user: requireEnv(env, 'POSTGRES_USER'),
      _password: requireEnv(env, 'POSTGRES_PASSWORD'),
    });
    neo4j = new Neo4jClient(requireEnv(env, 'NEO4J_URI'), requireEnv(env, 'NEO4J_USERNAME'), requireEnv(env, 'NEO4J_PASSWORD'));
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
  // Explicit exit: importing @cmdb/database opens a BullMQ Redis connection
  // that would otherwise keep the process alive.
  void main(process.argv.slice(2), process.env, {
    stdout: line => process.stdout.write(`${line}\n`),
    stderr: line => process.stderr.write(`${line}\n`),
  }).then(code => process.exit(code));
}
