// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Operator password rotation (HP1-S6, design v16 §1.1; founder ruling
 * exchange/approvals/cmdb-hp1-slices.go, COR16-1 acceptance).
 *
 * The only path that clears the default-password marker. One run rotates
 * one user. It sets a new password hash, clears `defaultPasswordSuspect`
 * and increments `credentialEpoch` in one guarded Neo4j transaction, which
 * refuses every earlier token, refresh token, API key and socket of that
 * user. It then revokes the user's pre-rotation API keys and audits the
 * result in auth_credential_events.
 *
 * Outcome protocol (COR15-1, COR16-1):
 * - An intent row is committed in PostgreSQL before Neo4j is touched.
 * - Every intent E is decided by exactly one immutable Neo4j node
 *   `(:CredentialRotationDecision {eventId: E})`, unique on eventId.
 *   - The apply transaction creates it as `applied`, atomically with the
 *     credential change.
 *   - The cancel transaction creates it as `cancelled`.
 *   - The uniqueness constraint lets only one of them commit. A committed
 *     cancel therefore makes any later apply of E fail with zero writes,
 *     however long its writer was delayed and whether or not that writer
 *     still holds the advisory lock.
 * - The PostgreSQL outcome row is written only from a decision node the
 *   script has observed: `applied` → password_rotated_operator,
 *   `cancelled` → password_rotation_not_applied. An absent decision is
 *   never a NOT_APPLIED outcome, however old the intent is. Without an
 *   observed decision the intent stays PENDING (Neo4j unreachable), and
 *   `--reconcile` resolves it later.
 *
 * The PostgreSQL advisory lock only keeps operators from interleaving
 * runs; no outcome depends on it.
 *
 * Usage (operator, direct DB access; never network-exposed):
 *   rotate-user-password --user-id <id> --operator <name>   (new password on stdin)
 *   rotate-user-password --reconcile --operator <name>
 * Exit codes: 0 APPLIED / reconciled, 2 refused, 3 NOT_APPLIED,
 * 4 PENDING, 5 open intent, 6 lock busy, 1 error.
 */

import * as bcrypt from 'bcrypt';
import neo4j from 'neo4j-driver';

import { DEFAULT_PLAINTEXTS, newPasswordAllowed, ROTATION_MIN_LENGTH } from '../auth/default-credentials';

import { isolateOperatorEnvironment, LockBusyError, openOperatorStores, type OperatorStores } from './operator-stores';


// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export const DECISION_CONSTRAINT_CYPHER = `
CREATE CONSTRAINT credential_rotation_decision_event IF NOT EXISTS
FOR (d:CredentialRotationDecision) REQUIRE d.eventId IS UNIQUE`;

/** The fence is only safe when the uniqueness constraint exists. */
export const DECISION_CONSTRAINT_PRESENT_CYPHER = `
SHOW CONSTRAINTS YIELD labelsOrTypes, properties, type
WHERE type IN ['UNIQUENESS', 'NODE_PROPERTY_UNIQUENESS']
  AND labelsOrTypes = ['CredentialRotationDecision'] AND properties = ['eventId']
RETURN true AS present`;

/** Identity precheck with exactly the runtime loader's predicate (neo4j-auth.repository.ts findUserById). */
export const IDENTITY_CYPHER = `
MATCH (u:User) WHERE u._id = $id OR u.id = $id
RETURN elementId(u) AS eid, u._id AS _id, u.id AS id, toInteger(coalesce(u.credentialEpoch, 0)) AS e0`;

/** Nodes any of this user's identifiers would resolve to. */
export const HOLDERS_CYPHER = `
MATCH (v:User) WHERE v._id IN $keys OR v.id IN $keys
RETURN count(v) AS holders`;

/**
 * Every guard is evaluated before any mutation; when one fails no row
 * reaches SET/CREATE and the transaction writes nothing (n = 0).
 */
export const APPLY_CYPHER = `
MATCH (u:User) WHERE elementId(u) = $eid
OPTIONAL MATCH (v:User) WHERE v._id IN $keys OR v.id IN $keys
WITH u, count(v) AS holders
WHERE (u._id = $id OR u.id = $id)
  AND coalesce(u.credentialEpoch, 0) = $e0
  AND holders = 1
SET u.passwordHash = $newHash, u._passwordHash = $newHash,
    u.defaultPasswordSuspect = false,
    u.credentialEpoch = $targetEpoch,
    u.passwordRotatedAt = datetime()
REMOVE u._defaultPasswordSuspect
CREATE (:CredentialRotationDecision {eventId: $eventId, outcome: 'applied', userKey: $key,
        targetEpoch: $targetEpoch, decidedAt: datetime()})
RETURN count(u) AS n`;

export const CANCEL_CYPHER = `
CREATE (:CredentialRotationDecision {eventId: $eventId, outcome: 'cancelled', reason: $reason, decidedAt: datetime()})`;

export const DECISION_CYPHER = `
MATCH (d:CredentialRotationDecision {eventId: $eventId})
RETURN d.outcome AS outcome, d.reason AS reason, d.targetEpoch AS targetEpoch`;

const OPEN_INTENTS_SQL = `
SELECT i.id, i.user_id, i.target_epoch
FROM auth_credential_events i
WHERE i.event = 'password_rotation_intent'
  AND NOT EXISTS (SELECT 1 FROM auth_credential_events o WHERE o.ref_event_id = i.id)
ORDER BY i.occurred_at, i.id`;

const INTENT_SQL = `
INSERT INTO auth_credential_events (user_id, event, target_epoch, actor)
VALUES ($1, 'password_rotation_intent', $2, $3)
RETURNING id`;

const REVOKE_SQL = `
UPDATE api_keys SET enabled = false, revoked_at = NOW()
WHERE user_id = $1 AND revoked_at IS NULL AND credential_epoch < $2
RETURNING id`;

const APPLIED_SQL = `
INSERT INTO auth_credential_events (user_id, event, ref_event_id, revoked_api_keys, actor)
VALUES ($1, 'password_rotated_operator', $2, $3, $4)`;

const NOT_APPLIED_SQL = `
INSERT INTO auth_credential_events (user_id, event, ref_event_id, reason, actor)
VALUES ($1, 'password_rotation_not_applied', $2, $3, $4)`;

const OUTCOME_SQL = `
SELECT event, reason, revoked_api_keys FROM auth_credential_events WHERE ref_event_id = $1`;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown>;

export interface RotationGraph {
  /** Auto-commit read routed to the primary. */
  read(cypher: string, params: Row): Promise<Row[]>;
  /** One explicit write transaction; resolves only after the commit is acknowledged. */
  write(cypher: string, params: Row): Promise<Row[]>;
}

export interface RotationSqlQuery {
  query(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}
export interface RotationSql extends RotationSqlQuery {
  transaction<T>(callback: (client: RotationSqlQuery) => Promise<T>): Promise<T>;
}

/** Session advisory lock on a dedicated connection; ergonomic only. */
export interface RotationLock {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

export interface RotationDeps {
  graph: RotationGraph;
  sql: RotationSql;
  lock: RotationLock;
  hash(password: string): Promise<string>;
  compare(password: string, hash: string): Promise<boolean>;
}

export type RefusalReason =
  | 'password_not_allowed' | 'unknown_identity' | 'ambiguous_identity' | 'identity_collision'
  | 'epoch_invalid' | 'decision_constraint_missing' | 'open_intent';

export class RotationRefused extends Error {
  constructor(readonly reason: RefusalReason) {
    super(`rotation refused: ${reason}`);
    this.name = 'RotationRefused';
  }

  get exitCode(): number {
    if (this.reason === 'open_intent') {
return 5;
}
    return 2;
  }
}

export interface RotationInput {
  userId: string;
  operator: string;
  password: string;
}

export interface PreparedRotation {
  eventId: string;
  userKey: string;
  targetEpoch: number;
  actor: string;
  /** Parameters of APPLY_CYPHER; epochs are Neo4j Integers (never Floats). */
  applyParams: Row;
}

export type RotationResult =
  | { eventId: string; outcome: 'APPLIED'; revokedApiKeys: number }
  | { eventId: string; outcome: 'NOT_APPLIED'; reason: 'guard_failed' | 'fenced' }
  | { eventId: string; outcome: 'PENDING' };

type Decision = { outcome: 'applied' } | { outcome: 'cancelled'; reason: 'guard_failed' | 'fenced' };

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

const toNumber = (value: unknown): number => (neo4j.isInt(value) ? neo4j.integer.toNumber(value) : Number(value));

/** Mapped user id exactly as Neo4jAuthRepository.mapUserNode derives `_id` (`props._id || props.id`). */
function mappedKey(row: Row): string {
  const underscored = row['_id'];
  return typeof underscored === 'string' && underscored !== '' ? underscored : String(row['id']);
}

async function refusePassword(password: string, deps: RotationDeps): Promise<string> {
  if (!newPasswordAllowed(password) || password.length < ROTATION_MIN_LENGTH) {
    throw new RotationRefused('password_not_allowed');
  }
  const newHash = await deps.hash(password);
  for (const plaintext of DEFAULT_PLAINTEXTS) {
    if (await deps.compare(plaintext, newHash)) {
      throw new RotationRefused('password_not_allowed');
    }
  }
  return newHash;
}

async function openIntents(sql: RotationSqlQuery): Promise<Row[]> {
  return (await sql.query(OPEN_INTENTS_SQL)).rows;
}

/**
 * Validates the password, checks the fence constraint, the open-intent
 * interlock and the user's identity, then commits the intent row.
 * The caller holds the lock.
 */
export async function prepareRotation(input: RotationInput, deps: RotationDeps): Promise<PreparedRotation> {
  const newHash = await refusePassword(input.password, deps);
  if ((await deps.graph.read(DECISION_CONSTRAINT_PRESENT_CYPHER, {})).length === 0) {
    throw new RotationRefused('decision_constraint_missing');
  }
  if ((await openIntents(deps.sql)).length > 0) {
    throw new RotationRefused('open_intent');
  }

  const matches = await deps.graph.read(IDENTITY_CYPHER, { id: input.userId });
  if (matches.length === 0) {
throw new RotationRefused('unknown_identity');
}
  if (matches.length > 1) {
throw new RotationRefused('ambiguous_identity');
}
  const row = matches[0]!;
  const keys = [row['_id'], row['id']].filter((value): value is string => typeof value === 'string');
  const [holders] = await deps.graph.read(HOLDERS_CYPHER, { keys });
  if (toNumber(holders?.['holders']) !== 1) {
throw new RotationRefused('identity_collision');
}
  if (row['e0'] === null || row['e0'] === undefined) {
throw new RotationRefused('epoch_invalid');
}
  const e0 = toNumber(row['e0']);
  if (!Number.isSafeInteger(e0) || e0 < 0) {
throw new RotationRefused('epoch_invalid');
}

  const userKey = mappedKey(row);
  const targetEpoch = e0 + 1;
  const actor = `operator:${input.operator}`;
  const [intent] = (await deps.sql.query(INTENT_SQL, [userKey, targetEpoch, actor])).rows;
  const eventId = String(intent!['id']);
  return {
    eventId, userKey, targetEpoch, actor,
    applyParams: {
      eid: row['eid'], id: input.userId, keys, key: userKey, eventId, newHash,
      e0: neo4j.int(e0), targetEpoch: neo4j.int(targetEpoch),
    },
  };
}

/** The committed decision for E, or null when none is observable (absent or unreadable). */
async function observeDecision(graph: RotationGraph, eventId: string): Promise<Decision | null> {
  try {
    const [row] = await graph.read(DECISION_CYPHER, { eventId });
    if (row?.['outcome'] === 'applied') {
return { outcome: 'applied' };
}
    if (row?.['outcome'] === 'cancelled') {
      return { outcome: 'cancelled', reason: row['reason'] === 'guard_failed' ? 'guard_failed' : 'fenced' };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fences E: commits a `cancelled` decision unless one already exists, then
 * returns whatever decision is committed. A cancel that fails on the
 * constraint means the apply (or an earlier cancel) won.
 */
async function fence(graph: RotationGraph, eventId: string, reason: 'guard_failed' | 'fenced'): Promise<Decision | null> {
  try {
    await graph.write(CANCEL_CYPHER, { eventId, reason });
  } catch {
    // Constraint violation (already decided) or Neo4j unavailable: read what is committed.
  }
  return observeDecision(graph, eventId);
}

/** Writes the PostgreSQL outcome the observed decision dictates; idempotent per intent. */
async function recordOutcome(
  sql: RotationSql, eventId: string, userKey: string, targetEpoch: number, actor: string, decision: Decision
): Promise<RotationResult> {
  try {
    return await sql.transaction(async client => {
      if (decision.outcome === 'applied') {
        const revoked = (await client.query(REVOKE_SQL, [userKey, targetEpoch])).rows.length;
        await client.query(APPLIED_SQL, [userKey, eventId, revoked, actor]);
        return { eventId, outcome: 'APPLIED', revokedApiKeys: revoked } as const;
      }
      await client.query(NOT_APPLIED_SQL, [userKey, eventId, decision.reason, actor]);
      return { eventId, outcome: 'NOT_APPLIED', reason: decision.reason } as const;
    });
  } catch (error) {
    // Another session (e.g. reconcile after this writer lost its lock) recorded the outcome first.
    const [existing] = (await sql.query(OUTCOME_SQL, [eventId])).rows;
    if (existing === undefined) {
throw error;
}
    return existing['event'] === 'password_rotated_operator'
      ? { eventId, outcome: 'APPLIED', revokedApiKeys: Number(existing['revoked_api_keys']) }
      : { eventId, outcome: 'NOT_APPLIED', reason: existing['reason'] === 'guard_failed' ? 'guard_failed' : 'fenced' };
  }
}

/**
 * Runs the apply transaction for a prepared intent and records the outcome
 * from the decision it observes. Safe to run late: a fenced intent cannot
 * apply, and an already-recorded outcome is returned, not duplicated.
 */
export async function applyRotation(prepared: PreparedRotation, deps: RotationDeps): Promise<RotationResult> {
  const { eventId, userKey, targetEpoch, actor } = prepared;
  let decision: Decision | null;
  try {
    const [row] = await deps.graph.write(APPLY_CYPHER, prepared.applyParams);
    decision = toNumber(row?.['n']) === 1
      ? { outcome: 'applied' }
      : await fence(deps.graph, eventId, 'guard_failed');
  } catch {
    // No acknowledged commit: the apply may or may not have committed. Only the fence decides.
    decision = await fence(deps.graph, eventId, 'fenced');
  }
  if (decision === null) {
    return { eventId, outcome: 'PENDING' };
  }
  try {
    return await recordOutcome(deps.sql, eventId, userKey, targetEpoch, actor, decision);
  } catch {
    return { eventId, outcome: 'PENDING' };
  }
}

async function withLock<T>(lock: RotationLock, run: () => Promise<T>): Promise<T> {
  await lock.acquire();
  try {
    return await run();
  } finally {
    await lock.release();
  }
}

export async function rotateUserPassword(input: RotationInput, deps: RotationDeps): Promise<RotationResult> {
  // Refuse a bad password before touching any lock or store.
  await refusePassword(input.password, deps);
  return withLock(deps.lock, async () => applyRotation(await prepareRotation(input, deps), deps));
}

/**
 * Resolves every intent without an outcome, oldest first: observe its
 * decision, fence it when none exists, and record the outcome the decision
 * dictates. Intents whose decision cannot be observed stay PENDING.
 */
export async function reconcileRotations(
  deps: RotationDeps, actor: string
): Promise<{ resolved: RotationResult[]; pending: string[] }> {
  return withLock(deps.lock, async () => {
    const resolved: RotationResult[] = [];
    const pending: string[] = [];
    for (const intent of await openIntents(deps.sql)) {
      const eventId = String(intent['id']);
      const decision = (await observeDecision(deps.graph, eventId)) ?? (await fence(deps.graph, eventId, 'fenced'));
      if (decision === null) {
        pending.push(eventId);
        continue;
      }
      try {
        resolved.push(await recordOutcome(
          deps.sql, eventId, String(intent['user_id']), Number(intent['target_epoch']), actor, decision
        ));
      } catch {
        pending.push(eventId);
      }
    }
    return { resolved, pending };
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: readonly string[]): { mode: 'rotate'; userId: string; operator: string } | { mode: 'reconcile'; operator: string } {
  let userId: string | undefined;
  let operator: string | undefined;
  let reconcile = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--reconcile' && !reconcile) {
reconcile = true;
} else if (arg === '--user-id' && userId === undefined && argv[i + 1] !== undefined) {
userId = argv[++i]!;
} else if (arg === '--operator' && operator === undefined && argv[i + 1] !== undefined) {
operator = argv[++i]!;
} else {
throw new Error(`unexpected argument: ${arg}`);
}
  }
  if (operator === undefined || operator.trim() === '') {
throw new Error('--operator <name> is required');
}
  if (reconcile) {
    if (userId !== undefined) {
throw new Error('--reconcile takes no --user-id');
}
    return { mode: 'reconcile', operator };
  }
  if (userId === undefined || userId === '') {
throw new Error('--user-id <id> is required');
}
  return { mode: 'rotate', userId, operator };
}

export function exitCodeOf(result: RotationResult): number {
  if (result.outcome === 'APPLIED') {
return 0;
}
  return result.outcome === 'NOT_APPLIED' ? 3 : 4;
}

async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
}
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

/**
 * CLI entry: connections come only from CMDB_ROTATE_* variables; the new
 * password only from stdin (never argv or env). Prints only the user id,
 * the event id and the outcome.
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: { stdin: NodeJS.ReadableStream; stdout: (line: string) => void; stderr: (line: string) => void }
): Promise<number> {
  let stores: OperatorStores | undefined;
  try {
    const args = parseArgs(argv);
    const rounds = Number(env['CMDB_ROTATE_BCRYPT_ROUNDS'] ?? '12');
    if (!Number.isInteger(rounds) || rounds < 10 || rounds > 15) {
throw new Error('CMDB_ROTATE_BCRYPT_ROUNDS must be 10-15');
}
    stores = openOperatorStores(env);
    const deps: RotationDeps = {
      graph: stores.graph, sql: stores.sql, lock: stores.lock,
      hash: password => bcrypt.hash(password, rounds),
      compare: (password, hash) => bcrypt.compare(password, hash),
    };

    if (args.mode === 'reconcile') {
      const { resolved, pending } = await reconcileRotations(deps, `operator:${args.operator}`);
      for (const result of resolved) {
io.stdout(JSON.stringify(result));
}
      for (const eventId of pending) {
io.stdout(JSON.stringify({ eventId, outcome: 'PENDING' }));
}
      return pending.length === 0 ? 0 : 4;
    }
    const result = await rotateUserPassword(
      { userId: args.userId, operator: args.operator, password: await readStdin(io.stdin) }, deps
    );
    io.stdout(JSON.stringify({ userId: args.userId, ...result }));
    return exitCodeOf(result);
  } catch (error) {
    if (error instanceof RotationRefused) {
      io.stderr(`rotate-user-password: ${error.message}`);
      return error.exitCode;
    }
    if (error instanceof LockBusyError) {
      io.stderr(`rotate-user-password: ${error.message}`);
      return 6;
    }
    io.stderr(`rotate-user-password: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await stores?.close();
  }
}

if (require.main === module) {
  isolateOperatorEnvironment(process.env);
  const writeLine = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);
  void main(process.argv.slice(2), process.env, {
    stdin: process.stdin,
    stdout: line => writeLine(`${line}\n`),
    stderr: line => process.stderr.write(`${line}\n`),
  }).then(code => process.exit(code));
}
