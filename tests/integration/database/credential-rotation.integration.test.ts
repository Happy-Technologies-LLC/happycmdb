// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HP1-S6 against real Neo4j 5.15 and PostgreSQL 15 (CI Testcontainers; all
 * migrations including 020 applied by the global setup):
 *
 * COR16-1 acceptance (signed founder ruling exchange/approvals/cmdb-hp1-slices.go):
 * - delayed Neo4j writer: an intent whose writer is suspended is fenced by
 *   reconcile; the late apply fails on the decision uniqueness with zero writes;
 * - PostgreSQL advisory-lock session loss while the writer is still alive:
 *   the writer's lock connection is terminated mid-transaction, reconcile
 *   takes the lock, and its cancel blocks on the uncommitted decision until
 *   the writer's transaction ends. Whichever commits first is the recorded
 *   outcome, in both orders.
 * - an absent decision plus intent age is never NOT_APPLIED.
 *
 * Also the real statements behind the unit models: the guarded self-service
 * password write and disable (SEC16-01), the transition-only marker setter
 * (SEC16-04) and the INTEGER generation (SEC16-03).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import * as bcrypt from 'bcrypt';
import neo4j, { Driver, Session } from 'neo4j-driver';
import { Pool } from 'pg';

import {
  APPLY_CYPHER, DECISION_CONSTRAINT_CYPHER, applyRotation, prepareRotation, reconcileRotations, rotateUserPassword,
  type RotationDeps,
} from '../../../packages/api-server/src/scripts/rotate-user-password';
import { openOperatorStores, type OperatorStores } from '../../../packages/api-server/src/scripts/operator-stores';
import {
  GUARDED_DISABLE_CYPHER, GUARDED_PASSWORD_CYPHER, MARK_DEFAULT_SUSPECT_CYPHER,
} from '../../../packages/api-server/src/auth/neo4j-auth.repository';

const USER = 'hp1-s6-rotation-user';
const NEW_PASSWORD = 'operator-rotated-16';

let driver: Driver;
let graph: Session;
let pool: Pool;
let defaultHash: string;
const stores: OperatorStores[] = [];

function operatorEnv(): NodeJS.ProcessEnv {
  return {
    CMDB_ROTATE_POSTGRES_HOST: process.env['POSTGRES_HOST'], CMDB_ROTATE_POSTGRES_PORT: process.env['POSTGRES_PORT'],
    CMDB_ROTATE_POSTGRES_DB: process.env['POSTGRES_DB'], CMDB_ROTATE_POSTGRES_USER: process.env['POSTGRES_USER'],
    CMDB_ROTATE_POSTGRES_PASSWORD: process.env['POSTGRES_PASSWORD'], CMDB_ROTATE_NEO4J_URI: process.env['NEO4J_URI'],
    CMDB_ROTATE_NEO4J_USERNAME: process.env['NEO4J_USERNAME'], CMDB_ROTATE_NEO4J_PASSWORD: process.env['NEO4J_PASSWORD'],
  };
}

/**
 * Resolves once Neo4j lists a transaction blocked on another one. Polling a
 * server-side condition: there is no client event for "now waiting on a lock".
 */
async function untilCancelBlocked(): Promise<void> {
  const monitor = driver.session();
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await monitor.run("SHOW TRANSACTIONS YIELD status WHERE status STARTS WITH 'Blocked' RETURN count(*) AS n");
      if (neo4j.integer.toNumber(result.records[0]!.get('n')) > 0) return;
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error('reconcile cancel never blocked on the writer transaction');
  } finally {
    await monitor.close();
  }
}

/** One operator process: its own store connections and advisory-lock session. */
function operator(): RotationDeps {
  const opened = openOperatorStores(operatorEnv());
  stores.push(opened);
  return {
    graph: opened.graph, sql: opened.sql, lock: opened.lock,
    hash: password => bcrypt.hash(password, 4),
    compare: (password, hash) => bcrypt.compare(password, hash),
  };
}

async function userProps(): Promise<Record<string, unknown>> {
  const result = await graph.run('MATCH (u:User {_id: $id}) RETURN properties(u) AS p', { id: USER });
  return result.records[0]!.get('p') as Record<string, unknown>;
}
async function events(): Promise<string[]> {
  return (await pool.query("SELECT event FROM auth_credential_events WHERE user_id = $1 ORDER BY occurred_at, id", [USER]))
    .rows.map(row => row.event as string);
}
async function keyEnabled(name: string): Promise<boolean> {
  return (await pool.query('SELECT enabled FROM api_keys WHERE name = $1', [name])).rows[0].enabled as boolean;
}

beforeAll(async () => {
  driver = neo4j.driver(process.env['NEO4J_URI']!, neo4j.auth.basic(process.env['NEO4J_USERNAME']!, process.env['NEO4J_PASSWORD']!));
  graph = driver.session();
  pool = new Pool({
    host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']), database: process.env['POSTGRES_DB'],
    user: process.env['POSTGRES_USER'], password: process.env['POSTGRES_PASSWORD'],
  });
  await graph.run(DECISION_CONSTRAINT_CYPHER);
  defaultHash = await bcrypt.hash('Admin123!', 4);
});

afterAll(async () => {
  await Promise.all(stores.map(s => s.close()));
  await graph?.run('MATCH (n) WHERE (n:User AND n._id STARTS WITH "hp1-s6-") OR n:CredentialRotationDecision DETACH DELETE n');
  await graph?.close();
  await driver?.close();
  await pool?.end();
});

beforeEach(async () => {
  // Disposable CI database; the audit table is append-only, so its owner lifts the trigger to reset.
  await pool.query('ALTER TABLE auth_credential_events DISABLE TRIGGER USER');
  await pool.query('DELETE FROM auth_credential_events');
  await pool.query('ALTER TABLE auth_credential_events ENABLE TRIGGER USER');
  await pool.query("DELETE FROM api_keys WHERE user_id LIKE 'hp1-s6-%'");
  await graph.run('MATCH (n) WHERE (n:User AND n._id STARTS WITH "hp1-s6-") OR n:CredentialRotationDecision DETACH DELETE n');
  await graph.run(
    'CREATE (:User {_id: $id, _username: $id, _passwordHash: $hash, _enabled: true, defaultPasswordSuspect: true})',
    { id: USER, hash: defaultHash }
  );
  await pool.query(
    "INSERT INTO api_keys (user_id, key_hash, name, role, credential_epoch) VALUES ($1, md5('pre') || md5('pre'), 'hp1-s6-pre', 'admin', 0)",
    [USER]
  );
});

describe('operator rotation against Neo4j 5.15 and PostgreSQL', () => {
  it('rotates: INTEGER generation 1, marker cleared, decision applied, pre-rotation key revoked', async () => {
    const result = await rotateUserPassword({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, operator());

    expect(result).toMatchObject({ outcome: 'APPLIED', revokedApiKeys: 1 });
    const props = await userProps();
    expect(neo4j.isInt(props['credentialEpoch'])).toBe(true);
    expect(neo4j.integer.toNumber(props['credentialEpoch'] as never)).toBe(1);
    expect(props['defaultPasswordSuspect']).toBe(false);
    expect(await keyEnabled('hp1-s6-pre')).toBe(false);
    expect(await events()).toEqual(['password_rotation_intent', 'password_rotated_operator']);
  });
});

describe('COR16-1: no false NOT_APPLIED from a delayed writer or a lost lock session', () => {
  it('delayed admission: reconcile fences the suspended writer; its late apply cannot land', async () => {
    const writer = operator();
    await writer.lock.acquire();
    const prepared = await prepareRotation({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, writer);
    await writer.lock.release(); // suspended writer; its session is gone
    const before = await userProps();

    const reconciled = await reconcileRotations(operator(), 'operator:ci');
    expect(reconciled.resolved).toEqual([expect.objectContaining({ eventId: prepared.eventId, outcome: 'NOT_APPLIED', reason: 'fenced' })]);

    const late = await applyRotation(prepared, writer);

    expect(late).toMatchObject({ outcome: 'NOT_APPLIED', reason: 'fenced' });
    expect(await userProps()).toEqual(before);
    expect(await keyEnabled('hp1-s6-pre')).toBe(true);
    expect(await events()).toEqual(['password_rotation_intent', 'password_rotation_not_applied']);
  });

  it.each(['writer commits first', 'writer aborts'] as const)(
    'lock session terminated while the writer transaction is open (%s): the recorded outcome matches the graph',
    async order => {
      const writer = operator();
      await writer.lock.acquire();
      const prepared = await prepareRotation({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, writer);
      // The writer's apply is in flight (BEGIN + RUN, no COMMIT yet).
      const writerSession = driver.session();
      const tx = writerSession.beginTransaction();
      await tx.run(APPLY_CYPHER, prepared.applyParams);
      // Its advisory-lock connection dies while the process lives on.
      await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()`);

      let settled = false;
      const reconciling = reconcileRotations(operator(), 'operator:ci').finally(() => { settled = true; });
      // Wait for the server to report reconcile's cancel as blocked on the writer's uncommitted decision.
      await untilCancelBlocked();
      expect(settled).toBe(false);

      if (order === 'writer commits first') await tx.commit();
      else await tx.rollback();
      await writerSession.close();
      const { resolved } = await reconciling;

      const props = await userProps();
      if (order === 'writer commits first') {
        expect(resolved).toEqual([expect.objectContaining({ outcome: 'APPLIED', revokedApiKeys: 1 })]);
        expect(neo4j.integer.toNumber(props['credentialEpoch'] as never)).toBe(1);
      } else {
        expect(resolved).toEqual([expect.objectContaining({ outcome: 'NOT_APPLIED', reason: 'fenced' })]);
        expect(props['credentialEpoch']).toBeUndefined();
        // The writer resumes and retries its apply: fenced, zero writes.
        expect(await applyRotation(prepared, writer)).toMatchObject({ outcome: 'NOT_APPLIED' });
        expect((await userProps())['credentialEpoch']).toBeUndefined();
      }
      expect((await events()).filter(e => e !== 'password_rotation_intent')).toHaveLength(1);
      await writer.lock.release(); // discards the terminated lock connection
    },
    30_000
  );

  it('an aged intent with no decision stays PENDING while Neo4j cannot record a fence', async () => {
    const writer = operator();
    await writer.lock.acquire();
    const prepared = await prepareRotation({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, writer);
    await writer.lock.release();
    await pool.query('ALTER TABLE auth_credential_events DISABLE TRIGGER USER');
    await pool.query("UPDATE auth_credential_events SET occurred_at = NOW() - interval '30 days' WHERE id = $1", [prepared.eventId]);
    await pool.query('ALTER TABLE auth_credential_events ENABLE TRIGGER USER');
    const reconciler = operator();
    reconciler.graph.write = async () => { throw new Error('ServiceUnavailable'); };

    expect(await reconcileRotations(reconciler, 'operator:ci')).toEqual({ resolved: [], pending: [prepared.eventId] });
    expect(await events()).toEqual(['password_rotation_intent']);

    // Clean up through the normal path.
    await reconcileRotations(operator(), 'operator:ci');
  });
});

describe('guarded self-service writes and the marker setter on Neo4j (SEC16-01, SEC16-04)', () => {
  async function elementId(): Promise<string> {
    return (await graph.run('MATCH (u:User {_id: $id}) RETURN elementId(u) AS e', { id: USER })).records[0]!.get('e') as string;
  }

  it('a password write or disable authorized at the old generation lands nowhere after a rotation', async () => {
    await graph.run('MATCH (u:User {_id: $id}) SET u.defaultPasswordSuspect = false', { id: USER }); // unmarked account
    const eid = await elementId();
    const readHash = defaultHash;
    await rotateUserPassword({ userId: USER, operator: 'ci', password: NEW_PASSWORD }, operator());
    const rotatedHash = (await userProps())['_passwordHash'];

    const write = await graph.run(GUARDED_PASSWORD_CYPHER, {
      elementId: eid, userId: USER, credentialEpoch: neo4j.int(0), readHash, newHash: 'attacker-hash',
    });
    const disable = await graph.run(GUARDED_DISABLE_CYPHER, { elementId: eid, userId: USER, credentialEpoch: neo4j.int(0) });

    expect(neo4j.integer.toNumber(write.records[0]!.get('n'))).toBe(0);
    expect(neo4j.integer.toNumber(disable.records[0]!.get('n'))).toBe(0);
    expect((await userProps())['_passwordHash']).toBe(rotatedHash);
    expect((await userProps())['_enabled']).toBe(true);
  });

  it('the login marker setter writes only the false → true transition', async () => {
    await graph.run('MATCH (u:User {_id: $id}) REMOVE u.defaultPasswordSuspect', { id: USER });
    const eid = await elementId();

    const first = await graph.run(MARK_DEFAULT_SUSPECT_CYPHER, { elementId: eid, userId: USER });
    const second = await graph.run(MARK_DEFAULT_SUSPECT_CYPHER, { elementId: eid, userId: USER });

    expect(neo4j.integer.toNumber(first.records[0]!.get('n'))).toBe(1);
    expect(neo4j.integer.toNumber(second.records[0]!.get('n'))).toBe(0);
  });
});
