// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Maintenance-window identity steps (HP1-S6, design v16 §1.1 and §12 step 6).
 * Operator-run only, under a separate named window instruction; nothing here
 * runs at API start.
 *
 * - `inventory`: lists every pre-provenance seed candidate (both property
 *   spellings, as mapUserNode reads them) with its match reason. Read-only.
 * - `stamp`: stamps seedProvenance = 'pre-cutover-inventory' (coalesce, so
 *   it never overwrites) on every candidate except ids the founder names as
 *   non-seed human accounts (`--except`).
 * - `scan`: one wrapped bcrypt compare of each stored hash against the
 *   default plaintexts; marks matches (false → true only) with one
 *   default_marker_set_scan row per transition; reports non-bcrypt ids.
 * - `grant-platform-admin`: sets the dedicated platform-admin flag (P-6) on
 *   exactly one unambiguous, non-seeded, unmarked user.
 * - `grant-portfolio-import-scope` / `revoke-portfolio-import-scope` (HAP-1632): adds or removes only the
 *   `portfolio:import` entry of one such user's stored `scopes` list; the other entries and every other
 *   property stay. Each granted/revoked change (not `unchanged`) appends one auth_credential_events row (HAP-2039)
 *   and prints its operator, time and event id; the grantedBy/At or revokedBy/At node properties stay as the
 *   latest-state cache only. Each of the three scope commands holds one PostgreSQL transaction-scoped advisory lock on the
 *   target user (HAP-2129, SCOPE_LOCK_SQL) across the Neo4j read/change and the audit insert, so concurrent runs on one
 *   user serialise and their rows follow the order of the Neo4j changes. The lock is a precondition: when PostgreSQL
 *   cannot be reached the command refuses (exit 1) before any Neo4j access.
 * - `record-portfolio-import-scope --grant|--revoke` (HAP-2129): writes the audit row of a scope change that is
 *   already applied in Neo4j (the exit-3 recovery) and makes no Neo4j write; it refuses unless the live scope list
 *   matches the action being recorded.
 *   HAP-2136: an earlier recovery row of the same event absorbs a record only while it is not older than the node's own
 *   grantedAt/revokedAt marker; a Neo4j write error whose outcome is unknown (state unchanged or unreadable on re-read)
 *   leaves a `window-script-ambiguous:<operator>` row and exits 1; exit-1 text is redacted (redactSecrets).
 * - `assign-organization`: sets the first organization (FD-5) of one such user
 *   that is not a platform admin and has none or a non-UUID one; never reassigns.
 *
 * Prints ids and counts only, never hashes.
 */

import * as bcrypt from 'bcrypt';
import neo4j from 'neo4j-driver';

import { DEFAULT_PLAINTEXTS } from '../auth/default-credentials';
import { isSeededAccount } from '../auth/platform-admin';
import { PORTFOLIO_IMPORT_SCOPE } from '../auth/scopes';
import { LOCK_USER } from '../auth/user-lock';
import { BCRYPT_HASH } from '../auth/password.service';

import { isolateOperatorEnvironment, openOperatorStores, type OperatorStores } from './operator-stores';
import type { RotationGraph, RotationSql, RotationSqlQuery, Row } from './rotate-user-password';

export const SEED_INVENTORY_CYPHER = `
MATCH (u:User)
WITH u, coalesce(u._id, u.id) AS id, coalesce(u._role, u.role) AS role,
        coalesce(u._organizationId, u.organizationId) AS org,
        toLower(coalesce(u._username, u.username, '')) AS uname,
        toLower(coalesce(u._email, u.email, '')) AS email
WHERE (org = '00000000-0000-0000-0000-000000000000' AND role = 'admin')
   OR id = 'user-admin-001' OR uname = 'admin' OR email = 'admin@happycmdb.local'
   OR u.seedProvenance IS NOT NULL
RETURN elementId(u) AS eid, id, role, org, uname, email, u.seedProvenance AS seedProvenance`;

export const SEED_STAMP_CYPHER = `
MATCH (u:User) WHERE elementId(u) IN $eids
SET u.seedProvenance = coalesce(u.seedProvenance, 'pre-cutover-inventory')
RETURN count(u) AS n`;

export const SCAN_USERS_CYPHER = `
MATCH (u:User)
RETURN elementId(u) AS eid, coalesce(u._id, u.id) AS id, coalesce(u._passwordHash, u.passwordHash) AS hash,
       toInteger(coalesce(u.credentialEpoch, 0)) AS e0`;

/**
 * Marks only while the node still holds the hash and generation the scan
 * verified, checked after taking the node's write lock: a rotation that
 * commits between the scan's read and this write is never re-marked.
 */
export const SCAN_MARK_CYPHER = `
MATCH (u:User) WHERE elementId(u) = $eid
${LOCK_USER}
WITH u
WHERE NOT (coalesce(u.defaultPasswordSuspect, false) OR coalesce(u._defaultPasswordSuspect, false))
  AND coalesce(u._passwordHash, u.passwordHash) = $verifiedHash
  AND coalesce(u.credentialEpoch, 0) = $verifiedEpoch
SET u.defaultPasswordSuspect = true
RETURN count(u) AS n`;

export const GRANT_IDENTITY_CYPHER = `
MATCH (u:User) WHERE u._id = $id OR u.id = $id
RETURN elementId(u) AS eid, u._id AS _id, u.id AS id,
       coalesce(u._username, u.username) AS username, coalesce(u._email, u.email) AS email,
       u.seedProvenance AS seedProvenance,
       (coalesce(u.defaultPasswordSuspect, false) OR coalesce(u._defaultPasswordSuspect, false)) AS marked,
       (coalesce(u._platformAdmin, false) = true OR coalesce(u.platformAdmin, false) = true) AS platformAdmin,
       coalesce(u._organizationId, u.organizationId) AS org,
       u.scopes AS scopes, coalesce(u.credentialEpoch, 0) AS epoch`;

export const GRANT_HOLDERS_CYPHER = `
MATCH (v:User) WHERE v._id IN $keys OR v.id IN $keys
RETURN count(v) AS holders`;

export const GRANT_PLATFORM_ADMIN_CYPHER = `
MATCH (u:User) WHERE elementId(u) = $eid
${LOCK_USER}
WITH u
WHERE (u._id = $id OR u.id = $id)
  AND u.seedProvenance IS NULL
  AND NOT (coalesce(u.defaultPasswordSuspect, false) OR coalesce(u._defaultPasswordSuspect, false))
SET u.platformAdmin = true, u.platformAdminGrantedBy = $operator, u.platformAdminGrantedAt = datetime()
RETURN count(u) AS n`;

/** Compare-and-set under the node's write lock: writes only while the refusals still pass
 * and the node still holds the organization the resolution observed (null or not a UUID). */
export const ASSIGN_ORGANIZATION_CYPHER = `
MATCH (u:User) WHERE elementId(u) = $eid
${LOCK_USER}
WITH u, coalesce(u._organizationId, u.organizationId) AS observed
WHERE (u._id = $id OR u.id = $id)
  AND u.seedProvenance IS NULL
  AND NOT (coalesce(u.defaultPasswordSuspect, false) OR coalesce(u._defaultPasswordSuspect, false))
  AND NOT (coalesce(u._platformAdmin, false) = true OR coalesce(u.platformAdmin, false) = true)
  AND (observed = $observed OR (observed IS NULL AND $observed IS NULL))
SET u._organizationId = $organizationId, u.organizationAssignedBy = $operator, u.organizationAssignedAt = datetime()
RETURN count(u) AS n`;

const SCAN_EVENT_SQL = `
INSERT INTO auth_credential_events (user_id, event, actor) VALUES ($1, 'default_marker_set_scan', $2)`;

/**
 * HAP-2039: the audit row of one scope change; the event is one of SCOPE_EVENTS, never user input.
 * HAP-2129: `occurred_at` is clock_timestamp(), the time of the insert, not the column default NOW() (the start of the
 * transaction, which now also spans the per-user lock wait): a run that waited for the lock began before the change it
 * waited on, and NOW() would date its row before that change's row. Rows of one user, inserted under the lock, are
 * thereby in `ORDER BY occurred_at` the order of the Neo4j changes.
 */
const SCOPE_EVENT_SQL = `
INSERT INTO auth_credential_events (user_id, event, actor, occurred_at) VALUES ($1, $2, $3, clock_timestamp())
RETURNING id, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at`;
/**
 * HAP-2129: the per-user lock of the scope commands. The two-integer advisory form with class 2129 (the HAP number):
 * pg_locks keeps it apart from every other advisory key in the repo, whether the one-bigint form (objsubid 1:
 * 'hp1:credential-rotation', hashtext('global') of the audit chain, the journal admission lock) or the other
 * two-integer class (8271, the CI-id locks), so no existing lock can be taken, or blocked, by a user id.
 * Transaction-scoped: released by the COMMIT or ROLLBACK that ends the audit insert's own transaction. hashtext is a
 * 32-bit hash: two user ids that collide serialise too, which costs only time.
 */
const SCOPE_LOCK_SQL = 'SELECT pg_advisory_xact_lock(2129, hashtext($1))';
const SCOPE_EVENTS = { granted: 'portfolio_import_scope_granted', revoked: 'portfolio_import_scope_revoked' } as const;
/** The stored actor of a real change is `window-script:<operator>`, of a record-only recovery row
 * `window-script-record:<operator>` (HAP-2131), of an ambiguous-outcome row `window-script-ambiguous:<operator>`
 * (HAP-2136), each in a VARCHAR(255). The event kind is the same for all three. */
const ACTOR_PREFIX = 'window-script:';
const RECORD_ACTOR_PREFIX = 'window-script-record:';
const AMBIGUOUS_ACTOR_PREFIX = 'window-script-ambiguous:';
/**
 * HAP-2131: the record-only insert. One statement, run under the per-user lock: it appends the recovery row unless the
 * user's latest scope row (any actor) is already a recovery row of this same event, in which case it appends nothing and
 * returns that row. So a retry after an ambiguous commit adds no duplicate. `inserted` tells the two apart.
 * HAP-2136: that earlier recovery row covers this record only when it is not older than the node's own marker of the
 * requested change ($4, epoch milliseconds of portfolioImportScopeGrantedAt / RevokedAt, null when absent). A later
 * grant/revoke cycle whose recovery was skipped re-stamps the marker after the earlier row, so it is not covered and
 * its own row is appended. A clock skew can only make the marker look newer than a row that does cover it, which
 * appends one extra, distinguishable recovery row; it never hides a change.
 */
const RECORD_EVENT_SQL = `
WITH latest AS (
  SELECT id, event, actor, occurred_at FROM auth_credential_events
  WHERE user_id = $1 AND event IN ('${SCOPE_EVENTS.granted}', '${SCOPE_EVENTS.revoked}')
  ORDER BY occurred_at DESC, id DESC LIMIT 1
), existing AS (
  SELECT id, actor, occurred_at FROM latest
  WHERE event = $2 AND actor LIKE '${RECORD_ACTOR_PREFIX}%'
    AND ($4::double precision IS NULL OR occurred_at >= to_timestamp($4::double precision / 1000))
), inserted AS (
  INSERT INTO auth_credential_events (user_id, event, actor, occurred_at)
  SELECT $1, $2, $3, clock_timestamp() WHERE NOT EXISTS (SELECT 1 FROM existing)
  RETURNING id, actor, occurred_at
)
SELECT id, actor, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at, true AS inserted FROM inserted
UNION ALL
SELECT id, actor, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at, false AS inserted FROM existing`;
/** HAP-2136: the node's own record of its latest scope changes, read by element id; the epoch is null while absent. */
export const SCOPE_MARKERS_CYPHER = `
MATCH (u:User) WHERE elementId(u) = $eid
RETURN u.portfolioImportScopeGrantedAt.epochMillis AS grantedMs, u.portfolioImportScopeRevokedAt.epochMillis AS revokedMs`;
const MAX_OPERATOR_LENGTH = 200;
const OPERATOR_INVALID = '--operator must be 1-200 printable characters';

const toNumber = (value: unknown): number => (neo4j.isInt(value) ? neo4j.integer.toNumber(value) : Number(value));
/** The API's organization-claim shape (auth.middleware.ts organizationClaim). */
const ORGANIZATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSIGNMENT = 'organization assignment';
const GRANT_ACTION = 'portfolio-import scope grant';
const REVOKE_ACTION = 'portfolio-import scope revoke';
const RECORD_COMMAND = 'record-portfolio-import-scope';
const RECORD_ACTION = 'portfolio-import scope record';
const COMMANDS = ['inventory', 'stamp', 'scan', 'grant-platform-admin', 'grant-portfolio-import-scope', 'revoke-portfolio-import-scope', RECORD_COMMAND, 'assign-organization'];
const SCOPE_COMMANDS = ['grant-portfolio-import-scope', 'revoke-portfolio-import-scope', RECORD_COMMAND];
const OPERATOR_COMMANDS = ['scan', 'grant-platform-admin', ...SCOPE_COMMANDS, 'assign-organization'];
const USAGE = 'usage: identity-window inventory | stamp [--except <id>]... | scan --operator <name> | grant-platform-admin --user-id <id> --operator <name> | grant-portfolio-import-scope --user-id <id> --operator <name> | revoke-portfolio-import-scope --user-id <id> --operator <name> | record-portfolio-import-scope --grant|--revoke --user-id <id> --operator <name> | assign-organization --user-id <id> --organization-id <uuid> --operator <name>';

export interface SeedCandidate {
  eid: string;
  id: string;
  reason: string;
}

export async function inventorySeedAccounts(graph: RotationGraph): Promise<SeedCandidate[]> {
  return (await graph.read(SEED_INVENTORY_CYPHER, {})).map(row => ({
    eid: String(row['eid']),
    id: String(row['id']),
    reason: row['seedProvenance'] !== null && row['seedProvenance'] !== undefined ? 'seedProvenance'
      : row['id'] === 'user-admin-001' ? 'init-neo4j id'
      : row['uname'] === 'admin' ? 'admin username'
      : row['email'] === 'admin@happycmdb.local' ? 'seeded admin email'
      : 'internal-org admin',
  }));
}

export async function stampSeedAccounts(graph: RotationGraph, except: readonly string[]): Promise<{ stamped: number; excepted: string[] }> {
  const candidates = await inventorySeedAccounts(graph);
  const eids = candidates.filter(c => !except.includes(c.id)).map(c => c.eid);
  const [row] = await graph.write(SEED_STAMP_CYPHER, { eids });
  return { stamped: toNumber(row?.['n']), excepted: candidates.filter(c => except.includes(c.id)).map(c => c.id) };
}

export async function scanDefaultPasswords(
  graph: RotationGraph, sql: RotationSqlQuery, compare: (password: string, hash: string) => Promise<boolean>, operator: string
): Promise<{ marked: string[]; alreadyMarkedOrRaced: string[]; nonBcrypt: string[] }> {
  const marked: string[] = [];
  const alreadyMarkedOrRaced: string[] = [];
  const nonBcrypt: string[] = [];
  for (const row of await graph.read(SCAN_USERS_CYPHER, {})) {
    const id = String(row['id']);
    const hash = row['hash'];
    if (typeof hash !== 'string' || !BCRYPT_HASH.test(hash)) {
      nonBcrypt.push(id);
      continue;
    }
    let matches = false;
    for (const plaintext of DEFAULT_PLAINTEXTS) {
      try {
        matches = (await compare(plaintext, hash)) || matches;
      } catch {
        // A library error is a mismatch.
      }
    }
    if (!matches || row['e0'] === null || row['e0'] === undefined) {
      continue;
    }
    const [result] = await graph.write(SCAN_MARK_CYPHER, { eid: row['eid'], verifiedHash: hash, verifiedEpoch: row['e0'] });
    if (toNumber(result?.['n']) === 1) {
      await sql.query(SCAN_EVENT_SQL, [id, `${ACTOR_PREFIX}${operator}`]);
      marked.push(id);
    } else {
      alreadyMarkedOrRaced.push(id);
    }
  }
  return { marked, alreadyMarkedOrRaced, nonBcrypt };
}

export type GrantRefusal = 'unknown_identity' | 'ambiguous_identity' | 'identity_collision' | 'seeded_account' | 'not_applied'
  | 'platform_admin_target' | 'already_assigned' | 'unsupported_value' | 'scope_state_mismatch';

export class GrantRefused extends Error {
  /** The message names the action and the fixed reason only, never a user or an organization. */
  constructor(readonly reason: GrantRefusal, action = 'platform-admin grant') {
    super(`${action} refused: ${reason}`);
    this.name = 'GrantRefused';
  }
}

/** The identity row and mapped id of exactly one unambiguous, non-seeded, unmarked user. */
async function resolveIdentity(graph: RotationGraph, userId: string, action?: string): Promise<{ row: Row; mappedId: string }> {
  const matches = await graph.read(GRANT_IDENTITY_CYPHER, { id: userId });
  if (matches.length === 0) {
    throw new GrantRefused('unknown_identity', action);
  }
  if (matches.length > 1) {
    throw new GrantRefused('ambiguous_identity', action);
  }
  const row: Row = matches[0]!;
  const keys = [row['_id'], row['id']].filter((value): value is string => typeof value === 'string');
  const [holders] = await graph.read(GRANT_HOLDERS_CYPHER, { keys });
  if (toNumber(holders?.['holders']) !== 1) {
    throw new GrantRefused('identity_collision', action);
  }
  const mappedId = typeof row['_id'] === 'string' && row['_id'] !== '' ? row['_id'] : String(row['id']);
  if (isSeededAccount({
    _id: mappedId,
    _username: typeof row['username'] === 'string' ? row['username'] : '',
    _email: typeof row['email'] === 'string' ? row['email'] : '',
    _seedProvenance: row['seedProvenance'] === null || row['seedProvenance'] === undefined ? undefined : String(row['seedProvenance']),
    _defaultPasswordSuspect: row['marked'] === true,
  })) {
    throw new GrantRefused('seeded_account', action);
  }
  return { row, mappedId };
}

/** Sets the platform-admin flag on exactly one unambiguous, non-seeded, unmarked user. */
export async function grantPlatformAdmin(graph: RotationGraph, userId: string, operator: string): Promise<{ userId: string }> {
  const { row, mappedId } = await resolveIdentity(graph, userId);
  const [result] = await graph.write(GRANT_PLATFORM_ADMIN_CYPHER, { eid: row['eid'], id: userId, operator });
  if (toNumber(result?.['n']) !== 1) {
throw new GrantRefused('not_applied');
}
  return { userId: mappedId };
}

/** Compare-and-set under the node's write lock: writes only while the grant refusals still pass and the node
 * still holds the scope list the resolution observed. Touches `scopes` and the audit properties, nothing else. */
export const GRANT_PORTFOLIO_IMPORT_SCOPE_CYPHER = `
MATCH (u:User) WHERE elementId(u) = $eid
${LOCK_USER}
WITH u
WHERE (u._id = $id OR u.id = $id)
  AND u.seedProvenance IS NULL
  AND NOT (coalesce(u.defaultPasswordSuspect, false) OR coalesce(u._defaultPasswordSuspect, false))
  AND coalesce(u.scopes, []) = $observed
SET u.scopes = $scopes, u.portfolioImportScopeGrantedBy = $operator, u.portfolioImportScopeGrantedAt = datetime()
RETURN count(u) AS n`;

export const REVOKE_PORTFOLIO_IMPORT_SCOPE_CYPHER = `
MATCH (u:User) WHERE elementId(u) = $eid
${LOCK_USER}
WITH u
WHERE (u._id = $id OR u.id = $id)
  AND u.seedProvenance IS NULL
  AND NOT (coalesce(u.defaultPasswordSuspect, false) OR coalesce(u._defaultPasswordSuspect, false))
  AND coalesce(u.scopes, []) = $observed
SET u.scopes = $scopes, u.portfolioImportScopeRevokedBy = $operator, u.portfolioImportScopeRevokedAt = datetime()
RETURN count(u) AS n`;

/** The stored scope list as the guarded write must see it: absent is empty; anything but a list of strings is refused. */
function observedScopes(row: Row, action: string): string[] {
  const stored: unknown = row['scopes'] ?? [];
  if (!Array.isArray(stored) || !stored.every((entry): entry is string => typeof entry === 'string')) {
    throw new GrantRefused('unsupported_value', action);
  }
  return stored;
}

export type ScopeChange =
  | { userId: string; outcome: 'unchanged' }
  | { userId: string; outcome: 'granted' | 'revoked'; operator: string; occurredAt: string; eventId: string };

/**
 * HAP-2129: the result of recording an already-applied change: the row the recording appended, no Neo4j write behind it.
 * HAP-2131: `alreadyRecorded` is true when the row is an earlier recovery row that this run found instead of appending
 * (a retry); `operator` is then that earlier row's operator.
 */
export interface ScopeRecord {
  userId: string;
  outcome: 'granted' | 'revoked';
  operator: string;
  occurredAt: string;
  eventId: string;
  recordOnly: true;
  alreadyRecorded: boolean;
}

/** The Neo4j change committed and its auth_credential_events row was not written. Carries no cause: the
 * message is fixed text naming the action and its record-only recovery, and the node properties stay as the fallback record. */
export class AuditWriteFailed extends Error {
  /** The recovery records the change that is already applied (HAP-2129): it never changes the scope again, so it
   * cannot leave the user in a state the operator did not ask for, and it does not depend on a second Neo4j change. */
  constructor(grant: boolean) {
    super(`${grant ? GRANT_ACTION : REVOKE_ACTION}: the scope change is applied but its audit row was not written; record it with: identity-window ${RECORD_COMMAND} ${grant ? '--grant' : '--revoke'} --user-id <id> --operator <name>`);
    this.name = 'AuditWriteFailed';
  }
}

/** The record-only command could not append its row. No Neo4j state was touched; fixed text, no cause. */
export class RecordWriteFailed extends Error {
  constructor() {
    super(`${RECORD_ACTION}: the audit row was not written and nothing else was changed; run the same command again`);
    this.name = 'RecordWriteFailed';
  }
}

/** The per-user lock could not be taken (PostgreSQL unreachable or refusing): refused before any Neo4j access. */
export class ScopeLockUnavailable extends Error {
  constructor(action: string) {
    super(`${action} refused: PostgreSQL is unavailable, so the per-user lock could not be taken; nothing was changed`);
    this.name = 'ScopeLockUnavailable';
  }
}

/**
 * Runs `work` in one PostgreSQL transaction that holds the target user's advisory lock from before the first Neo4j
 * read until the commit that makes the audit row visible. Failing to open the transaction or take the lock refuses
 * the whole command: `work` never runs, so no Neo4j read or write happens.
 */
async function underUserLock<T>(sql: RotationSql, userId: string, action: string, work: (tx: RotationSqlQuery) => Promise<T>): Promise<T> {
  let locked = false;
  try {
    return await sql.transaction(async tx => {
      await tx.query(SCOPE_LOCK_SQL, [userId]);
      locked = true;
      return work(tx);
    });
  } catch (error) {
    if (!locked) {
      throw new ScopeLockUnavailable(action);
    }
    throw error;
  }
}

/**
 * resolveIdentity under the lock keyed on the argument. A node that stores both `_id` and `id` answers to either, so
 * when the resolved id differs from the argument the resolved id's lock is taken too and the node is read again:
 * a run that came in by the other spelling is serialised behind this one before anything is written.
 */
async function resolveUnderLock(
  graph: RotationGraph, tx: RotationSqlQuery, userId: string, action: string
): ReturnType<typeof resolveIdentity> {
  const resolved = await resolveIdentity(graph, userId, action);
  if (resolved.mappedId === userId) {
    return resolved;
  }
  try {
    await tx.query(SCOPE_LOCK_SQL, [resolved.mappedId]);
  } catch {
    throw new ScopeLockUnavailable(action);
  }
  const reread = await resolveIdentity(graph, userId, action);
  // The node was read again only after the lock on the resolved id; if its id moved in between, the lock held is no
  // longer the one for this user: refuse before anything is written (nothing was) and let the operator run again.
  if (reread.mappedId !== resolved.mappedId) {
    throw new GrantRefused('not_applied', action);
  }
  return reread;
}

interface ScopeEventRow {
  userId: string;
  outcome: 'granted' | 'revoked';
  rows: Row[];
}

async function insertScopeEvent(tx: RotationSqlQuery, mappedId: string, outcome: 'granted' | 'revoked', operator: string): Promise<ScopeEventRow> {
  return { userId: mappedId, outcome, rows: (await tx.query(SCOPE_EVENT_SQL, [mappedId, SCOPE_EVENTS[outcome], `${ACTOR_PREFIX}${operator}`])).rows };
}

/** HAP-2136: the row of a change whose Neo4j outcome is unknown: the requested event, the ambiguous actor marker. */
async function insertAmbiguousEvent(tx: RotationSqlQuery, mappedId: string, outcome: 'granted' | 'revoked', operator: string): Promise<ScopeEventRow> {
  return { userId: mappedId, outcome, rows: (await tx.query(SCOPE_EVENT_SQL, [mappedId, SCOPE_EVENTS[outcome], `${AMBIGUOUS_ACTOR_PREFIX}${operator}`])).rows };
}

/** HAP-2131: the recovery row of an applied change, or the earlier recovery row that already covers it (`inserted` false).
 * `markerMs` is the node's own marker of this change (HAP-2136), null when the node has none. */
async function insertRecordEvent(
  tx: RotationSqlQuery, mappedId: string, outcome: 'granted' | 'revoked', operator: string, markerMs: number | null
): Promise<ScopeEventRow> {
  return { userId: mappedId, outcome, rows: (await tx.query(RECORD_EVENT_SQL, [mappedId, SCOPE_EVENTS[outcome], `${RECORD_ACTOR_PREFIX}${operator}`, markerMs])).rows };
}

/** Shaping of the committed row; it runs after the transaction, so an error here never claims the row was not written. */
function shapeEvent({ userId, outcome, rows }: ScopeEventRow, operator: string): Omit<ScopeRecord, 'recordOnly' | 'alreadyRecorded'> {
  const [event] = rows;
  return { userId, outcome, operator, occurredAt: String(event!['occurred_at']), eventId: String(event!['id']) };
}

/** The user's scope state as Neo4j holds it now, or undefined when it cannot be read (or is no longer eligible). */
async function holdsScopeNow(graph: RotationGraph, userId: string, action: string): Promise<boolean | undefined> {
  try {
    const { row } = await resolveIdentity(graph, userId, action);
    return observedScopes(row, action).includes(PORTFOLIO_IMPORT_SCOPE);
  } catch {
    return undefined;
  }
}

async function changePortfolioImportScope(
  graph: RotationGraph, sql: RotationSql, userId: string, operator: string, action: string, grant: boolean
): Promise<ScopeChange> {
  // Set once the Neo4j change has committed: from then on any failure to commit the row is AuditWriteFailed.
  let applied = false;
  let result: { unchanged: string } | { event: ScopeEventRow } | { ambiguous: unknown };
  // Set when the write errored with its outcome unknown and the ambiguous row was written in the transaction: the
  // original error is rethrown after the commit (or if the commit fails), never the commit's own.
  let ambiguous: { error: unknown } | undefined;
  try {
    result = await underUserLock(sql, userId, action, async tx => {
      const { row, mappedId } = await resolveUnderLock(graph, tx, userId, action);
      const observed = observedScopes(row, action);
      if (observed.includes(PORTFOLIO_IMPORT_SCOPE) === grant) {
        return { unchanged: mappedId };
      }
      const scopes = grant ? [...observed, PORTFOLIO_IMPORT_SCOPE] : observed.filter(scope => scope !== PORTFOLIO_IMPORT_SCOPE);
      let written: Row | undefined;
      try {
        [written] = await graph.write(
          grant ? GRANT_PORTFOLIO_IMPORT_SCOPE_CYPHER : REVOKE_PORTFOLIO_IMPORT_SCOPE_CYPHER,
          { eid: row['eid'], id: userId, observed, scopes, operator }
        );
      } catch (error) {
        // HAP-2131: the write errored on the client, but Neo4j may have committed it (the lost-acknowledgement case).
        // Under the lock nothing else writes, so a scope state that is now the requested one means the change is applied
        // and has no row: exit 3 with the record-only recovery, not the raw error.
        applied = (await holdsScopeNow(graph, userId, action)) === grant;
        if (applied) {
          throw error;
        }
        // HAP-2136: any other state (unchanged, or unreadable) is not proof the write never lands: Neo4j may still
        // apply it after this re-read. Record the requested change as ambiguous before exiting 1. If that row cannot
        // be written the original error stands (exit 1 either way; this path never exits 0).
        try {
          await insertAmbiguousEvent(tx, mappedId, grant ? 'granted' : 'revoked', operator);
        } catch {
          throw error;
        }
        ambiguous = { error };
        return { ambiguous: error };
      }
      if (toNumber(written?.['n']) !== 1) {
        throw new GrantRefused('not_applied', action);
      }
      applied = true;
      return { event: await insertScopeEvent(tx, mappedId, grant ? 'granted' : 'revoked', operator) };
    });
  } catch (error) {
    throw applied ? new AuditWriteFailed(grant) : ambiguous?.error ?? error;
  }
  if ('ambiguous' in result) {
    throw result.ambiguous;
  }
  return 'unchanged' in result ? { userId: result.unchanged, outcome: 'unchanged' } : shapeEvent(result.event, operator);
}

/** HAP-1632: adds `portfolio:import` to one eligible user's scopes, keeping every other entry; already held is `unchanged`. */
export function grantPortfolioImportScope(
  graph: RotationGraph, sql: RotationSql, userId: string, operator: string
): Promise<ScopeChange> {
  return changePortfolioImportScope(graph, sql, userId, operator, GRANT_ACTION, true);
}

/** HAP-1632: removes only `portfolio:import` from one eligible user's scopes; not held is `unchanged`. */
export function revokePortfolioImportScope(
  graph: RotationGraph, sql: RotationSql, userId: string, operator: string
): Promise<ScopeChange> {
  return changePortfolioImportScope(graph, sql, userId, operator, REVOKE_ACTION, false);
}

/**
 * HAP-2129: appends the audit row of a scope change that is already applied (the exit-3 recovery) and makes no Neo4j
 * write. Under the same per-user lock it reads the user's current scope and refuses (`scope_state_mismatch`, no row)
 * unless the live state is the one the action leaves: `grant` needs the scope held, `revoke` needs it absent.
 */
export async function recordPortfolioImportScope(
  graph: RotationGraph, sql: RotationSql, userId: string, operator: string, grant: boolean
): Promise<ScopeRecord> {
  let attempted = false;
  let event: ScopeEventRow;
  try {
    event = await underUserLock(sql, userId, RECORD_ACTION, async tx => {
      const { row, mappedId } = await resolveUnderLock(graph, tx, userId, RECORD_ACTION);
      if (observedScopes(row, RECORD_ACTION).includes(PORTFOLIO_IMPORT_SCOPE) !== grant) {
        throw new GrantRefused('scope_state_mismatch', RECORD_ACTION);
      }
      // HAP-2136: the node's marker of the change being recorded; an earlier recovery row covers this record only if
      // it is not older than that marker. An unreadable marker fails the command before any row is written.
      const [markers] = await graph.read(SCOPE_MARKERS_CYPHER, { eid: row['eid'] });
      const marker = markers?.[grant ? 'grantedMs' : 'revokedMs'];
      attempted = true;
      return insertRecordEvent(tx, mappedId, grant ? 'granted' : 'revoked', operator, marker === null || marker === undefined ? null : toNumber(marker));
    });
  } catch (error) {
    throw attempted ? new RecordWriteFailed() : error;
  }
  const [row] = event.rows;
  return { ...shapeEvent(event, String(row!['actor']).slice(RECORD_ACTOR_PREFIX.length)), recordOnly: true, alreadyRecorded: row!['inserted'] === false };
}

/** FD-5: assigns a user's first organization; the same one again is `unchanged` with no write. */
export async function assignOrganization(
  graph: RotationGraph, sql: RotationSqlQuery, userId: string, organizationId: string, operator: string
): Promise<{ userId: string; organizationId: string; outcome: 'assigned' | 'unchanged'; enabledApiKeys: number }> {
  const { row, mappedId } = await resolveIdentity(graph, userId).catch((error: unknown) => {
    throw error instanceof GrantRefused ? new GrantRefused(error.reason, ASSIGNMENT) : error;
  });
  if (row['platformAdmin'] === true) {
    throw new GrantRefused('platform_admin_target', ASSIGNMENT);
  }
  const observed = row['org'] ?? null;
  if (observed !== null && typeof observed !== 'string') {
    throw new GrantRefused('unsupported_value', ASSIGNMENT);
  }
  if (observed !== organizationId) {
    if (typeof observed === 'string' && ORGANIZATION_ID_RE.test(observed)) {
      throw new GrantRefused('already_assigned', ASSIGNMENT);
    }
    const [result] = await graph.write(ASSIGN_ORGANIZATION_CYPHER, { eid: row['eid'], id: userId, observed, organizationId, operator });
    if (toNumber(result?.['n']) !== 1) {
      throw new GrantRefused('not_applied', ASSIGNMENT);
    }
  }
  // Only keys at exactly the user's current generation can authenticate (verifyApiKey compares for equality); older and newer rows are generation-dead.
  // A stored generation that is not a safe Neo4j Integer (a Float, a string) refuses every key (mapCredentialEpoch yields NaN): none is counted.
  const epoch = row['epoch'];
  const generation = neo4j.isInt(epoch) && neo4j.integer.inSafeRange(epoch) ? neo4j.integer.toNumber(epoch) : null;
  const [keys] = generation === null ? [undefined] : (await sql.query(
    'SELECT count(*) AS n FROM api_keys WHERE user_id = $1 AND enabled AND revoked_at IS NULL AND credential_epoch = $2',
    [mappedId, generation]
  )).rows;
  return { userId: mappedId, organizationId, outcome: observed === organizationId ? 'unchanged' : 'assigned', enabledApiKeys: generation === null ? 0 : toNumber(keys?.['n']) };
}

/** Validated before any store opens; the messages never echo a value. */
function assignmentArgs(argv: readonly string[]): { userId: string; organizationId: string } {
  const [userId] = flagValues(argv, '--user-id');
  const [organizationId] = flagValues(argv, '--organization-id');
  if (userId === undefined) {
    throw new Error('--user-id <id> is required');
  }
  // Lowercase only: tenancy compares the id exactly, and an assigned id cannot be corrected later.
  if (organizationId !== undefined && organizationId !== organizationId.toLowerCase()) {
    throw new Error('--organization-id must be a lowercase UUID');
  }
  if (organizationId === undefined || !ORGANIZATION_ID_RE.test(organizationId)) {
    throw new Error('--organization-id <uuid> is required');
  }
  return { userId, organizationId };
}

function flagValues(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] !== undefined) {
values.push(argv[++i]!);
}
  }
  return values;
}

const VALUE_FLAGS = ['--operator', '--user-id', '--organization-id', '--except'];
/**
 * HAP-2136: a value flag directly followed by another value flag (`--operator --user-id p`) has no value of its own;
 * flagValues would read the next flag's name as the value. Refused before any store opens, without echoing a value.
 * `--grant`/`--revoke` as a value stay values (HAP-2131: `--operator --grant` names the operator `--grant`).
 */
function assertFlagValues(argv: readonly string[]): void {
  for (let i = 1; i < argv.length; i++) {
    if (VALUE_FLAGS.includes(argv[i]!)) {
      const next = argv[i + 1];
      if (next !== undefined && VALUE_FLAGS.includes(next)) {
        throw new Error(`${argv[i]} requires a value, found another flag in its place`);
      }
      i++;
    }
  }
}

const REDACTED = '***';
/**
 * HAP-2136: credential-like content of an error text, replaced before it is printed: URL userinfo, `Bearer <token>`, and
 * the value of any `password`/`passwd`/`token`/`secret` key (also inside a longer name such as `access_token`) after
 * `=` or `:`. Best effort for driver and network error text; the scope and rotation paths print fixed text instead.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, `$1${REDACTED}@`)
    .replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
    .replace(/(\b[\w.-]*(?:password|passwd|token|secret)[\w.-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, `$1${REDACTED}`);
}
/** HAP-2131: a bare flag (`--grant`, `--revoke`), matched only where it is a flag: the token after a value flag is that flag's value. */
function hasFlag(argv: readonly string[], flag: string): boolean {
  for (let i = 1; i < argv.length; i++) {
    if (VALUE_FLAGS.includes(argv[i]!)) {
      i++;
    } else if (argv[i] === flag) {
      return true;
    }
  }
  return false;
}

/**
 * CLI entry: `inventory` | `stamp [--except <id>]...` | `scan --operator <name>` |
 * `grant-platform-admin --user-id <id> --operator <name>` |
 * `grant-portfolio-import-scope --user-id <id> --operator <name>` |
 * `revoke-portfolio-import-scope --user-id <id> --operator <name>` |
 * `record-portfolio-import-scope --grant|--revoke --user-id <id> --operator <name>` |
 * `assign-organization --user-id <id> --organization-id <uuid> --operator <name>`. Connections come
 * only from CMDB_ROTATE_* variables. Prints ids and counts as JSON.
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: { stdout: (line: string) => void; stderr: (line: string) => void }
): Promise<number> {
  let stores: OperatorStores | undefined;
  try {
    const [command] = argv;
    if (!COMMANDS.includes(command ?? '')) {
      throw new Error(USAGE);
    }
    assertFlagValues(argv);
    const operator = flagValues(argv, '--operator')[0];
    if (OPERATOR_COMMANDS.includes(command ?? '') && (operator === undefined || operator.trim() === '')) {
      throw new Error('--operator <name> is required');
    }
    if (SCOPE_COMMANDS.includes(command ?? '') && flagValues(argv, '--user-id')[0] === undefined) {
      throw new Error('--user-id <id> is required');
    }
    // Scope commands only: the stored actor is `window-script:<operator>` or `window-script-record:<operator>`
    // (VARCHAR(255)), so an overlong value would fail the audit insert AFTER the Neo4j change. The message never echoes the value.
    const scopeOperator = SCOPE_COMMANDS.includes(command ?? '') ? operator!.trim() : undefined;
    if (scopeOperator !== undefined && ([...scopeOperator].length > MAX_OPERATOR_LENGTH || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(scopeOperator))) {
      throw new Error(OPERATOR_INVALID);
    }
    const recordGrant = hasFlag(argv, '--grant');
    if (command === RECORD_COMMAND && recordGrant === hasFlag(argv, '--revoke')) {
      throw new Error('exactly one of --grant or --revoke is required');
    }
    const assignment = command === 'assign-organization' ? assignmentArgs(argv) : undefined;
    stores = openOperatorStores(env);
    if (command === 'inventory') {
      io.stdout(JSON.stringify((await inventorySeedAccounts(stores.graph)).map(({ id, reason }) => ({ id, reason }))));
    } else if (command === 'stamp') {
      io.stdout(JSON.stringify(await stampSeedAccounts(stores.graph, flagValues(argv, '--except'))));
    } else if (command === 'scan') {
      io.stdout(JSON.stringify(await scanDefaultPasswords(stores.graph, stores.sql, (p, h) => bcrypt.compare(p, h), operator!)));
    } else if (command === 'grant-platform-admin') {
      const [userId] = flagValues(argv, '--user-id');
      if (userId === undefined) {
throw new Error('--user-id <id> is required');
}
      io.stdout(JSON.stringify(await grantPlatformAdmin(stores.graph, userId, operator!)));
    } else if (command === 'grant-portfolio-import-scope') {
      io.stdout(JSON.stringify(await grantPortfolioImportScope(stores.graph, stores.sql, flagValues(argv, '--user-id')[0]!, scopeOperator!)));
    } else if (command === 'revoke-portfolio-import-scope') {
      io.stdout(JSON.stringify(await revokePortfolioImportScope(stores.graph, stores.sql, flagValues(argv, '--user-id')[0]!, scopeOperator!)));
    } else if (command === RECORD_COMMAND) {
      io.stdout(JSON.stringify(await recordPortfolioImportScope(stores.graph, stores.sql, flagValues(argv, '--user-id')[0]!, scopeOperator!, recordGrant)));
    } else if (assignment !== undefined) {
      io.stdout(JSON.stringify(await assignOrganization(stores.graph, stores.sql, assignment.userId, assignment.organizationId, operator!)));
    } else {
      throw new Error(USAGE);
    }
    return 0;
  } catch (error) {
    io.stderr(`identity-window: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    return error instanceof GrantRefused ? 2 : error instanceof AuditWriteFailed ? 3 : 1;
  } finally {
    await stores?.close();
  }
}

if (require.main === module) {
  isolateOperatorEnvironment(process.env);
  const writeLine = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);
  void main(process.argv.slice(2), process.env, {
    stdout: line => writeLine(`${line}\n`),
    stderr: line => process.stderr.write(`${line}\n`),
  }).then(code => process.exit(code));
}
