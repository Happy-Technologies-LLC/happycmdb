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
 * Service ids are chosen by API clients, so a dim_business_services row
 * created after tenants could choose ids may claim the id of a node that was
 * never theirs (a Neo4j-only node, or one left behind by a deleted service).
 * `--created-before <timestamp>` is therefore required: only rows created
 * before it are trusted. Use the time migration 008 was applied:
 *   SELECT applied_at FROM cmdb.schema_migrations
 *    WHERE migration_name = '008_business_service_organization_scope.sql';
 * An org-less node whose only row is newer is left without an organization
 * and listed in `needs_review` for a manual decision.
 *
 * created_at is a TIMESTAMP without zone: the wall-clock time in the TimeZone
 * of the API session that wrote the row. `--writer-timezone <IANA name>` is
 * required and created_at is read in that zone (`created_at AT TIME ZONE`),
 * never in this backfill session's TimeZone, which may differ. Use the API
 * role's setting (`SHOW timezone` on an API connection), spelled as a zone
 * file name: `Etc/UTC` for UTC. The name must be in pg_timezone_names and must
 * not also be a time zone abbreviation (pg_timezone_abbrevs): AT TIME ZONE
 * reads abbreviations such as `EST` or `UTC` from the session's
 * timezone_abbreviations set, not the zone file. POSIX offsets such as '+05'
 * are refused too. The check runs before any graph statement.
 *
 * Workflow (each step an FD-7 operator action):
 *   1. --prepare (Neo4j only): creates the uniqueness constraint on
 *      :BusinessServiceBackfillIncarnation(uuid), then in one Neo4j write
 *      transaction links each org-less :BusinessService without an anchor to a
 *      new anchor with a random UUID (HAS_BACKFILL_INCARNATION). It writes no
 *      organization, and nothing in this script deletes an anchor.
 *   2. dry run (writes nothing): emits the plan - every Postgres owner and, per
 *      fillable node, its id, elementId and anchor UUID - and plan_sha256.
 *      Trusted org-less nodes without an anchor are listed in needs_prepare
 *      and are not planned; a node with more than one anchor aborts the run.
 *   3. --apply --plan <saved dry run> --sha256 <independently reviewed digest>.
 *
 * Why anchors: elementId is only guaranteed within one transaction and may be
 * reused after deletion, so id + elementId cannot tell a reviewed node from a
 * same-id replacement. Deleting the node removes its anchor edge, and a
 * replacement - even with every property copied - has no edge to the reviewed
 * anchor. Trust model: application writers do not create
 * HAS_BACKFILL_INCARNATION edges or delete/relink anchors; privileged manual
 * relinking is outside what this check proves and must be prevented
 * operationally.
 *
 * Apply guards:
 *   - the plan must be intact (digest, cutover, zone, owner/target shape,
 *     unique ids and anchors, targets drawn from trusted owners);
 *   - Postgres owner rows are re-read with SELECT ... FOR SHARE inside a
 *     transaction held until the Neo4j transaction finishes; any drift from
 *     the plan aborts before a graph write;
 *   - in one Neo4j write transaction each reviewed node and its anchor are
 *     write-locked, then the edge (exactly one on each side), the elementId
 *     and the null organization are rechecked; any missing, extra or changed
 *     row rolls the whole graph transaction back;
 *   - no cross-database atomic commit: if Neo4j commits but PostgreSQL commit
 *     or the process fails, inspect both stores before any retry;
 *   - nodes already owned are never changed; unmatched and post-cutover nodes
 *     remain invisible and require manual review;
 *   - connections use CMDB_BACKFILL_* only; credentials never print.
 *
 * There is no automatic undo: an anchor identifies the node incarnation, not
 * who later set or restored its organization. See
 * doc-site/docs/components/authentication.md for the manual procedure.
 *
 * Not run automatically, not part of schema initialization or db-init. Build
 * with `npm run build:tenant-fixture --workspace=packages/api-server`
 * (tsconfig.scripts.json compiles src/scripts), then:
 *   CMDB_BACKFILL_POSTGRES_HOST=... CMDB_BACKFILL_POSTGRES_PORT=5432 CMDB_BACKFILL_POSTGRES_DB=... \
 *   CMDB_BACKFILL_POSTGRES_USER=... CMDB_BACKFILL_POSTGRES_PASSWORD=... \
 *   [CMDB_BACKFILL_POSTGRES_SSL=require|verify-full] \
 *   CMDB_BACKFILL_NEO4J_URI=bolt://<host>:7687 CMDB_BACKFILL_NEO4J_USERNAME=... CMDB_BACKFILL_NEO4J_PASSWORD=... \
 *   [CMDB_BACKFILL_NEO4J_ENCRYPTED=true|false] \
 *   node packages/api-server/dist/tenant-fixture/api-server/src/scripts/backfill-business-service-organization.js \
 *     --prepare | --created-before <ISO-8601 timestamp with zone> --writer-timezone <zone file name, e.g. Etc/UTC> \
 *     [--apply --plan <saved dry-run summary> --sha256 <independently reviewed plan_sha256>]
 * (--prepare needs only the CMDB_BACKFILL_NEO4J_* variables.)
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';

// Deliberately not the @cmdb/database barrel: importing it opens a BullMQ Redis
// connection at load time. These modules open nothing until a client is constructed.
import { Neo4jClient } from '../../../database/src/neo4j/client';
import { PostgresClient } from '../../../database/src/postgres/client';

/** Same shape the api-server accepts as an organization claim (auth.middleware.ts). */
const ORGANIZATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ISO-8601 timestamp with an explicit zone, so the cutover is never read in a local time zone. */
const CUTOVER_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The writer time zone must be a zone file name Postgres knows and not also an
 * abbreviation, which AT TIME ZONE would resolve through the session's
 * timezone_abbreviations set instead; checked before any graph statement.
 */
export const WRITER_TIMEZONE_SQL = `
SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1)
   AND NOT EXISTS (SELECT 1 FROM pg_timezone_abbrevs WHERE lower(abbrev) = lower($1)) AS known`;

/**
 * Owner of every business service id (service_id is the primary key;
 * organization_id is NOT NULL since 008). `trusted`: created before the
 * cutover ($1), with created_at read in the writer time zone ($2), so the
 * session TimeZone plays no part.
 */
export const OWNERS_SQL = `
SELECT service_id,
       organization_id::text AS organization_id,
       created_at::text AS created_at,
       (created_at IS NOT NULL AND (created_at AT TIME ZONE $2::text) < $1::timestamptz) AS trusted
  FROM dim_business_services
 ORDER BY service_id`;

export const LOCKED_OWNERS_SQL = `${OWNERS_SQL} FOR SHARE`;

/** Unique, never-reused incarnation anchors (append-only; the backfill never deletes them). */
export const INCARNATION_CONSTRAINT_CYPHER = `
CREATE CONSTRAINT business_service_backfill_incarnation_uuid IF NOT EXISTS
FOR (a:BusinessServiceBackfillIncarnation) REQUIRE a.uuid IS UNIQUE`;

/**
 * --prepare: links every org-less node that has no anchor to a fresh UUID
 * anchor. Deleting the node (DETACH DELETE) drops the edge, and copying the
 * node's properties onto a replacement does not recreate it.
 */
export const PREPARE_CYPHER = `
MATCH (bs:BusinessService)
WHERE bs.organization_id IS NULL AND NOT (bs)-[:HAS_BACKFILL_INCARNATION]->(:BusinessServiceBackfillIncarnation)
CREATE (bs)-[:HAS_BACKFILL_INCARNATION]->(a:BusinessServiceBackfillIncarnation {uuid: randomUUID(), service_id: bs.id, prepared_at: datetime()})
RETURN bs.id AS serviceId, a.uuid AS incarnation
ORDER BY serviceId`;

/**
 * Writes only the reviewed incarnation: node and anchor are write-locked
 * first, then the edge, its uniqueness on both ends and the null organization
 * are rechecked under those locks.
 */
export const FILL_CYPHER = `
UNWIND $targets AS target
MATCH (bs:BusinessService {id: target.serviceId})-[:HAS_BACKFILL_INCARNATION]->(a:BusinessServiceBackfillIncarnation {uuid: target.incarnation})
SET bs._backfill_lock = true, a._backfill_lock = true
REMOVE bs._backfill_lock, a._backfill_lock
WITH bs, a, target
WHERE bs.organization_id IS NULL AND elementId(bs) = target.elementId
  AND EXISTS { (bs)-[:HAS_BACKFILL_INCARNATION]->(a) }
  AND COUNT { (bs)-[:HAS_BACKFILL_INCARNATION]->() } = 1
  AND COUNT { ()-[:HAS_BACKFILL_INCARNATION]->(a) } = 1
SET bs.organization_id = target.organizationId
RETURN bs.id AS serviceId, elementId(bs) AS elementId, a.uuid AS incarnation, bs.organization_id AS organizationId`;

/** Org-less nodes with their anchors (only anchors linked to exactly this node); writes nothing. */
export const FILLABLE_CYPHER = `
UNWIND $owners AS owner
MATCH (bs:BusinessService {id: owner.serviceId})
WHERE bs.organization_id IS NULL
RETURN bs.id AS serviceId, elementId(bs) AS elementId, owner.organizationId AS organizationId,
       COUNT { (bs)-[:HAS_BACKFILL_INCARNATION]->() } AS anchorEdges,
       [(bs)-[:HAS_BACKFILL_INCARNATION]->(a:BusinessServiceBackfillIncarnation)
         WHERE COUNT { ()-[:HAS_BACKFILL_INCARNATION]->(a) } = 1 | a.uuid] AS incarnations`;

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
  transaction<T>(callback: (client: Pick<SqlClient, 'query'>) => Promise<T>): Promise<T>;
}

/** Minimal Neo4j session/transaction surface (driver session satisfies it). */
export interface GraphQuery {
  run(query: string, params?: Record<string, unknown>): Promise<{ records: Array<{ get(key: string): unknown }> }>;
}
export interface GraphSession extends GraphQuery {
  executeWrite<T>(callback: (tx: GraphQuery) => Promise<T>): Promise<T>;
}

export interface BackfillSummary {
  mode: 'dry-run' | 'apply';
  /** Rows created before this are trusted. */
  created_before: string;
  /** Zone in which created_at (a TIMESTAMP without zone) was read. */
  writer_timezone: string;
  /** dim_business_services rows read. */
  postgres_services: number;
  /** Only the actual writes on apply, or proposed writes on dry run, with the node's incarnation anchor. */
  filled: Array<{ service_id: string; organization_id: string; incarnation: string }>;
  /** Dry run only: trusted org-less nodes without an anchor; run --prepare, then a new dry run. */
  needs_prepare?: Array<{ service_id: string; organization_id: string }>;
  /** Dry-run-only immutable review input; supply this entire summary via --plan on apply. */
  plan?: BackfillPlan;
  plan_sha256: string;
  /** Org-less nodes whose only row is not older than the cutover; left without an organization. */
  needs_review: Array<{ service_id: string; organization_id: string; created_at: string | null }>;
  /** Org-less nodes with no Postgres row; they stay invisible. */
  unmatched: number;
  /** Nodes whose organization differs from Postgres; left unchanged. */
  conflicting: number;
}

interface Owner { serviceId: string; organizationId: string; createdAt: string | null; trusted: boolean }
interface Target { serviceId: string; organizationId: string; elementId: string; incarnation: string }
export interface BackfillPlan {
  created_before: string;
  writer_timezone: string;
  owners: Owner[];
  targets: Target[];
}

export interface PrepareSummary {
  mode: 'prepare';
  /** Org-less nodes linked to a new incarnation anchor by this run. */
  prepared: Array<{ service_id: string; incarnation: string }>;
}

export function planHash(plan: BackfillPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

/** Neo4j returns integers as Integer; fakes may return numbers. */
function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : (value as { toNumber(): number } | undefined)?.toNumber() ?? 0;
}

/** Runs a single-count statement. */
async function count(session: GraphQuery, cypher: string, params: Record<string, unknown>, key: string): Promise<number> {
  const result = await session.run(cypher, params);
  return toNumber(result.records[0]?.get(key));
}

interface Candidate { serviceId: string; organizationId: string; elementId: string; anchorEdges: number; incarnations: string[] }

/** Org-less nodes of these owners, with their anchors; writes nothing. */
async function candidates(session: GraphQuery, owners: Owner[]): Promise<Candidate[]> {
  if (owners.length === 0) return [];
  const result = await session.run(FILLABLE_CYPHER, {
    owners: owners.map(({ serviceId, organizationId }) => ({ serviceId, organizationId })),
  });
  return result.records.map(record => ({
    serviceId: record.get('serviceId') as string,
    organizationId: record.get('organizationId') as string,
    elementId: record.get('elementId') as string,
    anchorEdges: toNumber(record.get('anchorEdges')),
    incarnations: record.get('incarnations') as string[],
  }));
}

/**
 * FD-7 --prepare: creates the anchor uniqueness constraint, then, in one
 * Neo4j write transaction, links each org-less node without an anchor to a
 * new UUID anchor. Writes no organization; anchors are never deleted.
 */
export async function prepareBusinessServiceIncarnations(session: GraphSession): Promise<PrepareSummary> {
  // Schema and data statements cannot share a Neo4j transaction.
  await session.run(INCARNATION_CONSTRAINT_CYPHER);
  const prepared = await session.executeWrite(async tx => {
    const result = await tx.run(PREPARE_CYPHER);
    return result.records.map(record => ({
      service_id: record.get('serviceId') as string,
      incarnation: record.get('incarnation') as string,
    }));
  });
  return { mode: 'prepare', prepared };
}

function parseOwners(rows: Array<Record<string, unknown>>): Owner[] {
  return rows.map(row => {
    const serviceId = row['service_id'];
    const organizationId = row['organization_id'];
    if (typeof serviceId !== 'string' || serviceId.length === 0) {
      throw new Error('dim_business_services has a row with an empty service_id; nothing was written');
    }
    if (typeof organizationId !== 'string' || !ORGANIZATION_ID_RE.test(organizationId)) {
      throw new Error(`dim_business_services row ${serviceId} has no valid organization_id; nothing was written`);
    }
    return {
      serviceId,
      organizationId,
      createdAt: typeof row['created_at'] === 'string' ? row['created_at'] : null,
      trusted: row['trusted'] === true,
    };
  });
}

export async function backfillBusinessServiceOrganizations(
  postgres: SqlClient,
  session: GraphSession,
  options: { apply: boolean; createdBefore: string; writerTimezone: string; reviewed?: BackfillSummary; sha256?: string }
): Promise<BackfillSummary> {
  if (!CUTOVER_RE.test(options.createdBefore) || !Number.isFinite(Date.parse(options.createdBefore))) {
    throw new Error('--created-before must be an ISO-8601 timestamp with a zone, e.g. 2026-10-01T12:00:00Z');
  }
  if (options.apply) {
    const plan = options.reviewed?.plan;
    if (options.reviewed?.mode !== 'dry-run' || !plan ||
        !Array.isArray(plan.owners) || !Array.isArray(plan.targets) ||
        !/^[0-9a-f]{64}$/.test(options.sha256 ?? '') ||
        planHash(plan) !== options.sha256 || options.reviewed.plan_sha256 !== options.sha256 ||
        options.reviewed.created_before !== options.createdBefore ||
        options.reviewed.writer_timezone !== options.writerTimezone ||
        plan.created_before !== options.createdBefore || plan.writer_timezone !== options.writerTimezone ||
        !Array.isArray(options.reviewed.filled) ||
        JSON.stringify(options.reviewed.filled) !== JSON.stringify(plan.targets.map(t => ({
          service_id: t?.serviceId, organization_id: t?.organizationId, incarnation: t?.incarnation,
        }))) ||
        plan.owners.some(o => !o || typeof o.serviceId !== 'string' || typeof o.organizationId !== 'string' ||
          typeof o.trusted !== 'boolean' || (o.createdAt !== null && typeof o.createdAt !== 'string')) ||
        plan.targets.some(t => !t || typeof t.serviceId !== 'string' || typeof t.elementId !== 'string' ||
          !t.elementId || typeof t.organizationId !== 'string' ||
          typeof t.incarnation !== 'string' || !ORGANIZATION_ID_RE.test(t.incarnation)) ||
        new Set(plan.targets.map(t => t.incarnation)).size !== plan.targets.length ||
        new Set(plan.targets.map(t => t.serviceId)).size !== plan.targets.length ||
        plan.targets.some(t => !plan.owners.some(o => o.trusted && o.serviceId === t.serviceId && o.organizationId === t.organizationId))) {
      throw new Error('apply requires an intact dry-run --plan and its independently reviewed --sha256; nothing was written');
    }
  }
  const zone = await postgres.query(WRITER_TIMEZONE_SQL, [options.writerTimezone]);
  if (zone.rows[0]?.['known'] !== true) {
    throw new Error(`--writer-timezone ${options.writerTimezone} is not a time zone file name in pg_timezone_names (or is also an abbreviation); use e.g. Etc/UTC; nothing was written`);
  }

  const run = async (sql: Pick<SqlClient, 'query'>): Promise<BackfillSummary> => {
    const { rows } = await sql.query(options.apply ? LOCKED_OWNERS_SQL : OWNERS_SQL, [options.createdBefore, options.writerTimezone]);
    const owners = parseOwners(rows);
    if (options.apply && JSON.stringify(owners) !== JSON.stringify(options.reviewed!.plan!.owners)) {
      throw new Error('Postgres ownership/cutover drift from reviewed plan; nothing was written');
    }
    const all = { owners: owners.map(({ serviceId, organizationId }) => ({ serviceId, organizationId })) };
    const conflicting = await count(session, COUNT_CONFLICTING_CYPHER, all, 'conflicting');
    const unmatched = await count(session, COUNT_UNMATCHED_CYPHER, { serviceIds: owners.map(o => o.serviceId) }, 'unmatched');
    const untrusted = owners.filter(owner => !owner.trusted);
    const review = await candidates(session, untrusted);
    let targets: Target[];
    let needsPrepare: Candidate[] = [];
    if (options.apply) {
      targets = options.reviewed!.plan!.targets;
    } else {
      const found = await candidates(session, owners.filter(owner => owner.trusted));
      if (new Set(found.map(c => c.serviceId)).size !== found.length ||
          found.some(c => typeof c.elementId !== 'string' || !c.elementId ||
            c.anchorEdges > 1 || c.incarnations.length !== c.anchorEdges)) {
        throw new Error('duplicate business service id, missing graph identity or ambiguous incarnation anchor; no plan emitted');
      }
      needsPrepare = found.filter(c => c.anchorEdges === 0);
      targets = found.filter(c => c.anchorEdges === 1).map(c => ({
        serviceId: c.serviceId, organizationId: c.organizationId, elementId: c.elementId, incarnation: c.incarnations[0]!,
      }));
    }
    const plan: BackfillPlan = options.apply ? options.reviewed!.plan! : {
      created_before: options.createdBefore, writer_timezone: options.writerTimezone, owners, targets,
    };
    const filled = options.apply ? await session.executeWrite(async tx => {
      if (targets.length === 0) return [];
      const result = await tx.run(FILL_CYPHER, { targets });
      const written: Target[] = result.records.map(record => ({
        serviceId: record.get('serviceId') as string,
        organizationId: record.get('organizationId') as string,
        elementId: record.get('elementId') as string,
        incarnation: record.get('incarnation') as string,
      }));
      if (written.length !== targets.length ||
          written.some(w => !targets.some(t => t.serviceId === w.serviceId && t.elementId === w.elementId &&
            t.incarnation === w.incarnation && t.organizationId === w.organizationId))) {
        throw new Error('Neo4j identity/organization drift from reviewed plan; graph transaction rolled back');
      }
      return written;
    }) : targets;

    return {
      mode: options.apply ? 'apply' : 'dry-run',
      created_before: options.createdBefore,
      writer_timezone: options.writerTimezone,
      postgres_services: owners.length,
      filled: filled.map(m => ({ service_id: m.serviceId, organization_id: m.organizationId, incarnation: m.incarnation })),
      ...(!options.apply ? { needs_prepare: needsPrepare.map(c => ({ service_id: c.serviceId, organization_id: c.organizationId })) } : {}),
      ...(!options.apply ? { plan } : {}),
      plan_sha256: planHash(plan),
      needs_review: review.map(m => ({
        service_id: m.serviceId,
        organization_id: m.organizationId,
        created_at: untrusted.find(owner => owner.serviceId === m.serviceId)?.createdAt ?? null,
      })),
      unmatched,
      conflicting,
    };
  };
  return options.apply ? postgres.transaction(run) : run(postgres);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

type BackfillArgs = { apply: boolean; createdBefore: string; writerTimezone: string; planFile?: string; sha256?: string };

/**
 * `--prepare` alone (anchors only), or a dry run; --apply requires an
 * independently reviewed plan and SHA-256.
 */
export function parseArgs(argv: readonly string[]): { mode: 'prepare' } | ({ mode: 'backfill' } & BackfillArgs) {
  if (argv.length === 1 && argv[0] === '--prepare') {
    return { mode: 'prepare' };
  }
  let apply = false;
  let createdBefore: string | undefined;
  let writerTimezone: string | undefined;
  let planFile: string | undefined;
  let sha256: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--apply' && !apply) {
      apply = true;
    } else if (arg === '--created-before' && createdBefore === undefined && argv[i + 1] !== undefined) {
      createdBefore = argv[++i]!;
    } else if (arg === '--writer-timezone' && writerTimezone === undefined && argv[i + 1] !== undefined) {
      writerTimezone = argv[++i]!;
    } else if (arg === '--plan' && planFile === undefined && argv[i + 1] !== undefined) {
      planFile = argv[++i]!;
    } else if (arg === '--sha256' && sha256 === undefined && argv[i + 1] !== undefined) {
      sha256 = argv[++i]!;
    } else {
      throw new Error(`unexpected argument ${arg}; usage: --prepare | --created-before <ISO-8601 timestamp> --writer-timezone <zone file name> [--apply --plan <dry-run summary file> --sha256 <reviewed digest>]`);
    }
  }
  if (createdBefore === undefined) {
    throw new Error('--created-before <ISO-8601 timestamp with a zone> is required, e.g. 2026-10-01T12:00:00Z');
  }
  if (writerTimezone === undefined) {
    throw new Error('--writer-timezone <IANA time zone of the API sessions> is required, e.g. Etc/UTC');
  }
  if (apply !== (planFile !== undefined && sha256 !== undefined)) {
    throw new Error('--apply requires --plan <dry-run summary file> and --sha256 <independently reviewed digest>');
  }
  return { mode: 'backfill', apply, createdBefore, writerTimezone, planFile, sha256 };
}

/**
 * CLI entry: validates arguments and CMDB_BACKFILL_* before any client exists,
 * runs --prepare (Neo4j only) or the backfill (dry run unless --apply),
 * prints the summary, and returns the exit code.
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: { stdout: (line: string) => void; stderr: (line: string) => void }
): Promise<number> {
  let postgres: PostgresClient | undefined;
  let neo4j: Neo4jClient | undefined;
  try {
    const args = parseArgs(argv);
    const reviewed = args.mode === 'prepare' || args.planFile === undefined
      ? undefined
      : JSON.parse(readFileSync(args.planFile, 'utf8')) as BackfillSummary;
    const encryptedSetting = env['CMDB_BACKFILL_NEO4J_ENCRYPTED'];
    if (encryptedSetting !== undefined && encryptedSetting !== 'true' && encryptedSetting !== 'false') {
      throw new Error('CMDB_BACKFILL_NEO4J_ENCRYPTED must be true or false when set');
    }
    const uri = required(env, 'CMDB_BACKFILL_NEO4J_URI');
    if (!/^(bolt|neo4j):\/\/[^/@?#]+$/.test(uri)) {
      throw new Error('CMDB_BACKFILL_NEO4J_URI must be bolt://<host>[:port] or neo4j://<host>[:port] (use CMDB_BACKFILL_NEO4J_ENCRYPTED=true for TLS)');
    }
    const neo4jUsername = required(env, 'CMDB_BACKFILL_NEO4J_USERNAME');
    const neo4jPassword = required(env, 'CMDB_BACKFILL_NEO4J_PASSWORD');
    if (args.mode === 'backfill') {
      const port = Number(required(env, 'CMDB_BACKFILL_POSTGRES_PORT'));
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error('CMDB_BACKFILL_POSTGRES_PORT must be a TCP port');
      }
      const sslSetting = env['CMDB_BACKFILL_POSTGRES_SSL'];
      const ssl: 'require' | 'verify-full' | false = sslSetting === 'require' || sslSetting === 'verify-full' ? sslSetting : false;
      if (sslSetting !== undefined && ssl === false) {
        throw new Error('CMDB_BACKFILL_POSTGRES_SSL must be require or verify-full when set');
      }
      postgres = new PostgresClient({
        _host: required(env, 'CMDB_BACKFILL_POSTGRES_HOST'),
        _port: port,
        _database: required(env, 'CMDB_BACKFILL_POSTGRES_DB'),
        _user: required(env, 'CMDB_BACKFILL_POSTGRES_USER'),
        _password: required(env, 'CMDB_BACKFILL_POSTGRES_PASSWORD'),
        ssl,
      });
    }
    neo4j = new Neo4jClient(uri, neo4jUsername, neo4jPassword, { encrypted: encryptedSetting === 'true' });

    const session = neo4j.getSession();
    try {
      const summary = args.mode === 'prepare'
        ? await prepareBusinessServiceIncarnations(session)
        : await backfillBusinessServiceOrganizations(postgres!, session, { ...args, reviewed });
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
