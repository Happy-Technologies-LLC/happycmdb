// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Backfill :BusinessService.organization_id from PostgreSQL (FD-16 c).
 * MANUAL OPERATOR ACTION. Applying it to a live database is gated by FD-7.
 *
 * TBM, dashboard and pool-aggregation reads only count a :BusinessService node
 * whose organization_id equals the caller's token organization. Nodes written
 * before that carry no organization_id and are invisible to every
 * organization. For each such node, this sets organization_id to the
 * organization that owns the same service_id in dim_business_services.
 *
 * Guards:
 *   - dry run by default: nothing is written unless `--apply` is passed; the
 *     dry run reports what `--apply` would change;
 *   - only nodes whose organization_id is null are written; a node that
 *     already has an organization keeps it, even when Postgres disagrees
 *     (counted as `conflicting`, never changed);
 *   - a node with no Postgres row stays without an organization, so it stays
 *     invisible (fail closed; counted as `unmatched`);
 *   - every Postgres row is validated (non-empty service_id, UUID
 *     organization_id) before anything is written; one bad row aborts the run;
 *   - idempotent: a second run changes nothing;
 *   - connections come only from dedicated CMDB_BACKFILL_* variables, never
 *     the api-server's own POSTGRES_* / NEO4J_* settings; credentials are read
 *     from the environment (not argv) and never printed. stdout carries one
 *     JSON summary line; errors go to stderr without connection details.
 *
 * Not run automatically, not part of schema initialization or db-init. Build
 * with `npm run build:tenant-fixture --workspace=packages/api-server`
 * (tsconfig.scripts.json compiles src/scripts), then:
 *   CMDB_BACKFILL_POSTGRES_HOST=... CMDB_BACKFILL_POSTGRES_PORT=5432 CMDB_BACKFILL_POSTGRES_DB=... \
 *   CMDB_BACKFILL_POSTGRES_USER=... CMDB_BACKFILL_POSTGRES_PASSWORD=... \
 *   [CMDB_BACKFILL_POSTGRES_SSL=require|verify-full] \
 *   CMDB_BACKFILL_NEO4J_URI=bolt://<host>:7687 CMDB_BACKFILL_NEO4J_USERNAME=... CMDB_BACKFILL_NEO4J_PASSWORD=... \
 *   [CMDB_BACKFILL_NEO4J_ENCRYPTED=true] \
 *   node packages/api-server/dist/tenant-fixture/api-server/src/scripts/backfill-business-service-organization.js [--apply]
 */

// Deliberately not the @cmdb/database barrel: importing it opens a BullMQ Redis
// connection at load time. These modules open nothing until a client is constructed.
import { Neo4jClient } from '../../../database/src/neo4j/client';
import { PostgresClient } from '../../../database/src/postgres/client';

/** Same shape the api-server accepts as an organization claim (auth.middleware.ts). */
const ORGANIZATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owner of every business service id (service_id is the primary key; organization_id is NOT NULL since 008). */
export const OWNERS_SQL =
  'SELECT service_id, organization_id::text AS organization_id FROM dim_business_services ORDER BY service_id';

/** Fills only org-less nodes, from the owner of the same id. */
export const FILL_CYPHER = `
UNWIND $owners AS owner
MATCH (bs:BusinessService {id: owner.serviceId})
WHERE bs.organization_id IS NULL
SET bs.organization_id = owner.organizationId
RETURN count(bs) AS filled`;

/** Dry run: the nodes FILL_CYPHER would write. */
export const COUNT_FILLABLE_CYPHER = `
UNWIND $owners AS owner
MATCH (bs:BusinessService {id: owner.serviceId})
WHERE bs.organization_id IS NULL
RETURN count(bs) AS filled`;

/** Org-less nodes with no Postgres row: left without an organization. */
export const COUNT_UNMATCHED_CYPHER = `
MATCH (bs:BusinessService)
WHERE bs.organization_id IS NULL AND NOT bs.id IN $serviceIds
RETURN count(bs) AS unmatched`;

/** Nodes whose organization differs from Postgres: reported, never changed. */
export const COUNT_CONFLICTING_CYPHER = `
UNWIND $owners AS owner
MATCH (bs:BusinessService {id: owner.serviceId})
WHERE bs.organization_id IS NOT NULL AND bs.organization_id <> owner.organizationId
RETURN count(bs) AS conflicting`;

/** Minimal Postgres surface (PostgresClient satisfies it). */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Minimal Neo4j session surface (a driver session satisfies it). */
export interface GraphSession {
  run(query: string, params?: Record<string, unknown>): Promise<{ records: Array<{ get(key: string): unknown }> }>;
}

export interface BackfillSummary {
  mode: 'dry-run' | 'apply';
  /** dim_business_services rows read. */
  postgres_services: number;
  /** Nodes given an organization (apply), or that would be (dry run). */
  filled: number;
  /** Org-less nodes with no Postgres row; they stay invisible. */
  unmatched: number;
  /** Nodes whose organization differs from Postgres; left unchanged. */
  conflicting: number;
}

/** Runs a single-count statement; Neo4j returns counts as Integer, fakes may return numbers. */
async function count(session: GraphSession, cypher: string, params: Record<string, unknown>, key: string): Promise<number> {
  const result = await session.run(cypher, params);
  const value = result.records[0]?.get(key) as { toNumber(): number } | number | undefined;
  return typeof value === 'number' ? value : value?.toNumber() ?? 0;
}

export async function backfillBusinessServiceOrganizations(
  postgres: SqlClient,
  session: GraphSession,
  options: { apply: boolean }
): Promise<BackfillSummary> {
  const { rows } = await postgres.query(OWNERS_SQL);
  const owners = rows.map(row => {
    const serviceId = row['service_id'];
    const organizationId = row['organization_id'];
    if (typeof serviceId !== 'string' || serviceId.length === 0) {
      throw new Error('dim_business_services has a row with an empty service_id; nothing was written');
    }
    if (typeof organizationId !== 'string' || !ORGANIZATION_ID_RE.test(organizationId)) {
      throw new Error(`dim_business_services row ${serviceId} has no valid organization_id; nothing was written`);
    }
    return { serviceId, organizationId: organizationId.toLowerCase() };
  });
  const params = { owners, serviceIds: owners.map(owner => owner.serviceId) };

  const conflicting = await count(session, COUNT_CONFLICTING_CYPHER, params, 'conflicting');
  const unmatched = await count(session, COUNT_UNMATCHED_CYPHER, params, 'unmatched');
  const filled = await count(session, options.apply ? FILL_CYPHER : COUNT_FILLABLE_CYPHER, params, 'filled');

  return { mode: options.apply ? 'apply' : 'dry-run', postgres_services: owners.length, filled, unmatched, conflicting };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * CLI entry: reads the target from CMDB_BACKFILL_*, runs the backfill (dry run
 * unless --apply), prints the summary, and returns the exit code.
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: { stdout: (line: string) => void; stderr: (line: string) => void }
): Promise<number> {
  let postgres: PostgresClient | undefined;
  let neo4j: Neo4jClient | undefined;
  try {
    const unknown = argv.filter(arg => arg !== '--apply');
    if (unknown.length > 0) {
      throw new Error(`unknown argument ${unknown[0]}; the only option is --apply`);
    }
    const port = Number(required(env, 'CMDB_BACKFILL_POSTGRES_PORT'));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('CMDB_BACKFILL_POSTGRES_PORT must be a TCP port');
    }
    const sslSetting = env['CMDB_BACKFILL_POSTGRES_SSL'];
    const ssl = sslSetting === 'require' || sslSetting === 'verify-full' ? sslSetting : false;
    if (sslSetting !== undefined && ssl === false) {
      throw new Error('CMDB_BACKFILL_POSTGRES_SSL must be require or verify-full when set');
    }
    const uri = required(env, 'CMDB_BACKFILL_NEO4J_URI');
    if (!/^(bolt|neo4j):\/\/[^/@?#]+$/.test(uri)) {
      throw new Error('CMDB_BACKFILL_NEO4J_URI must be bolt://<host>[:port] or neo4j://<host>[:port] (use CMDB_BACKFILL_NEO4J_ENCRYPTED=true for TLS)');
    }

    postgres = new PostgresClient({
      _host: required(env, 'CMDB_BACKFILL_POSTGRES_HOST'),
      _port: port,
      _database: required(env, 'CMDB_BACKFILL_POSTGRES_DB'),
      _user: required(env, 'CMDB_BACKFILL_POSTGRES_USER'),
      _password: required(env, 'CMDB_BACKFILL_POSTGRES_PASSWORD'),
      ssl: ssl ?? false,
    });
    neo4j = new Neo4jClient(
      uri,
      required(env, 'CMDB_BACKFILL_NEO4J_USERNAME'),
      required(env, 'CMDB_BACKFILL_NEO4J_PASSWORD'),
      { encrypted: env['CMDB_BACKFILL_NEO4J_ENCRYPTED'] === 'true' }
    );

    const session = neo4j.getSession();
    try {
      const summary = await backfillBusinessServiceOrganizations(postgres, session, { apply: argv.includes('--apply') });
      io.stdout(JSON.stringify(summary));
    } finally {
      await session.close();
    }
    return 0;
  } catch (error) {
    io.stderr(`backfill-business-service-organization: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await postgres?.close();
    await neo4j?.close();
  }
}

if (require.main === module) {
  // stdout is reserved for the JSON summary; every other stdout write (the
  // shared winston Console transport, libraries) goes to stderr.
  const writeSummary = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);
  // PostgresClient / Neo4jClient also read the api-server's own TLS toggles
  // from process.env; the backfill's connections are defined only by
  // CMDB_BACKFILL_*, so drop those before any client exists.
  for (const name of ['POSTGRES_SSL_MODE', 'POSTGRES_SSL_ENABLED', 'NEO4J_SSL_ENABLED', 'NEO4J_ENCRYPTION', 'NEO4J_SSL_TRUST_STRATEGY']) {
    delete process.env[name];
  }
  // Explicit exit so a lingering driver socket cannot keep the process alive.
  void main(process.argv.slice(2), process.env, {
    stdout: line => writeSummary(`${line}\n`),
    stderr: line => process.stderr.write(`${line}\n`),
  }).then(code => process.exit(code));
}
