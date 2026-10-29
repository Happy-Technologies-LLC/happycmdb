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
 * - `assign-organization`: sets the first organization (FD-5) of one such user
 *   that is not a platform admin and has none or a non-UUID one; never reassigns.
 *
 * Prints ids and counts only, never hashes.
 */

import * as bcrypt from 'bcrypt';
import neo4j from 'neo4j-driver';

import { DEFAULT_PLAINTEXTS } from '../auth/default-credentials';
import { isSeededAccount } from '../auth/platform-admin';
import { LOCK_USER } from '../auth/user-lock';

import { isolateOperatorEnvironment, openOperatorStores, type OperatorStores } from './operator-stores';
import type { RotationGraph, RotationSqlQuery, Row } from './rotate-user-password';

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
       coalesce(u._organizationId, u.organizationId) AS org`;

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

const toNumber = (value: unknown): number => (neo4j.isInt(value) ? neo4j.integer.toNumber(value) : Number(value));
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
/** The API's organization-claim shape (auth.middleware.ts organizationClaim). */
const ORGANIZATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASSIGNMENT = 'organization assignment';

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
      await sql.query(SCAN_EVENT_SQL, [id, `window-script:${operator}`]);
      marked.push(id);
    } else {
      alreadyMarkedOrRaced.push(id);
    }
  }
  return { marked, alreadyMarkedOrRaced, nonBcrypt };
}

export type GrantRefusal = 'unknown_identity' | 'ambiguous_identity' | 'identity_collision' | 'seeded_account' | 'not_applied'
  | 'platform_admin_target' | 'already_assigned' | 'unsupported_value';

export class GrantRefused extends Error {
  /** The message names the action and the fixed reason only, never a user or an organization. */
  constructor(readonly reason: GrantRefusal, action = 'platform-admin grant') {
    super(`${action} refused: ${reason}`);
    this.name = 'GrantRefused';
  }
}

/** The identity row and mapped id of exactly one unambiguous, non-seeded, unmarked user. */
async function resolveIdentity(graph: RotationGraph, userId: string): Promise<{ row: Row; mappedId: string }> {
  const matches = await graph.read(GRANT_IDENTITY_CYPHER, { id: userId });
  if (matches.length === 0) {
throw new GrantRefused('unknown_identity');
}
  if (matches.length > 1) {
throw new GrantRefused('ambiguous_identity');
}
  const row: Row = matches[0]!;
  const keys = [row['_id'], row['id']].filter((value): value is string => typeof value === 'string');
  const [holders] = await graph.read(GRANT_HOLDERS_CYPHER, { keys });
  if (toNumber(holders?.['holders']) !== 1) {
throw new GrantRefused('identity_collision');
}
  const mappedId = typeof row['_id'] === 'string' && row['_id'] !== '' ? row['_id'] : String(row['id']);
  if (isSeededAccount({
    _id: mappedId,
    _username: typeof row['username'] === 'string' ? row['username'] : '',
    _email: typeof row['email'] === 'string' ? row['email'] : '',
    _seedProvenance: row['seedProvenance'] === null || row['seedProvenance'] === undefined ? undefined : String(row['seedProvenance']),
    _defaultPasswordSuspect: row['marked'] === true,
  })) {
    throw new GrantRefused('seeded_account');
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
  const [keys] = (await sql.query('SELECT count(*) AS n FROM api_keys WHERE user_id = $1 AND enabled AND revoked_at IS NULL', [mappedId])).rows;
  return { userId: mappedId, organizationId, outcome: observed === organizationId ? 'unchanged' : 'assigned', enabledApiKeys: toNumber(keys?.['n']) };
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
    throw new Error('--organization-id <uuid> is required');
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

/**
 * CLI entry: `inventory` | `stamp [--except <id>]...` | `scan --operator <name>` |
 * `grant-platform-admin --user-id <id> --operator <name>` |
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
    const operator = flagValues(argv, '--operator')[0];
    if (['scan', 'grant-platform-admin', 'assign-organization'].includes(command ?? '') && (operator === undefined || operator.trim() === '')) {
      throw new Error('--operator <name> is required');
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
    } else if (assignment !== undefined) {
      io.stdout(JSON.stringify(await assignOrganization(stores.graph, stores.sql, assignment.userId, assignment.organizationId, operator!)));
    } else {
      throw new Error('usage: identity-window inventory | stamp [--except <id>]... | scan --operator <name> | grant-platform-admin --user-id <id> --operator <name> | assign-organization --user-id <id> --organization-id <uuid> --operator <name>');
    }
    return 0;
  } catch (error) {
    io.stderr(`identity-window: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof GrantRefused ? 2 : 1;
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
