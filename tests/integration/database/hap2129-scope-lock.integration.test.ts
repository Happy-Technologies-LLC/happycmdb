// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-2129 on a real PostgreSQL (CI Testcontainers; migrations 020 and 055 applied by the global setup): the
 * identity-window scope commands hold a per-user transaction-scoped advisory lock across the Neo4j read/change and the
 * audit insert. Two PostgreSQL sessions are needed to show it, which the single-session PGlite unit tests cannot give.
 * The graph is an in-memory model of the exported statements, so the Neo4j side is deterministic and gateable: the
 * only real store is PostgreSQL, through the real openOperatorStores().
 */
import { randomUUID } from 'crypto';
import neo4j from 'neo4j-driver';
import { Pool } from 'pg';

import { PORTFOLIO_IMPORT_SCOPE } from '../../../packages/api-server/src/auth/scopes';
import {
  GRANT_HOLDERS_CYPHER, GRANT_IDENTITY_CYPHER, GrantRefused, SCOPE_MARKERS_CYPHER, ScopeLockUnavailable,
  grantPortfolioImportScope, recordPortfolioImportScope, revokePortfolioImportScope,
} from '../../../packages/api-server/src/scripts/identity-window';
import { openOperatorStores, type OperatorStores } from '../../../packages/api-server/src/scripts/operator-stores';
import type { RotationGraph } from '../../../packages/api-server/src/scripts/rotate-user-password';

const stores: OperatorStores[] = [];
let monitor: Pool;

/** One operator process: its own PostgreSQL pool (so its own sessions), as two CLI runs have. */
function operator(overrides: NodeJS.ProcessEnv = {}): OperatorStores {
  const opened = openOperatorStores({
    CMDB_ROTATE_POSTGRES_HOST: process.env['POSTGRES_HOST'], CMDB_ROTATE_POSTGRES_PORT: process.env['POSTGRES_PORT'],
    CMDB_ROTATE_POSTGRES_DB: process.env['POSTGRES_DB'], CMDB_ROTATE_POSTGRES_USER: process.env['POSTGRES_USER'],
    CMDB_ROTATE_POSTGRES_PASSWORD: process.env['POSTGRES_PASSWORD'],
    // Never connected to: the graph below is the in-memory model.
    CMDB_ROTATE_NEO4J_URI: 'bolt://127.0.0.1:1', CMDB_ROTATE_NEO4J_USERNAME: 'neo4j', CMDB_ROTATE_NEO4J_PASSWORD: 'unused',
    ...overrides,
  });
  stores.push(opened);
  return opened;
}

beforeAll(() => {
  monitor = new Pool({
    host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']), database: process.env['POSTGRES_DB'],
    user: process.env['POSTGRES_USER'], password: process.env['POSTGRES_PASSWORD'], max: 2,
  });
});
afterAll(async () => {
  await Promise.all(stores.map(store => store.close()));
  await monitor.end();
});

interface Deferred { promise: Promise<void>; resolve: () => void }
const gates: Deferred[] = [];
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  const gate = { promise, resolve };
  gates.push(gate);
  return gate;
}
// A failed assertion must not leave a run parked at its gate (it would hold its lock and hang the suite).
afterEach(() => { gates.splice(0).forEach(gate => gate.resolve()); });

/** A user node's scope list, shared by every graph view of it (one Neo4j). */
function memoryUser(scopes: string[]) {
  const id = `hap2129-${randomUUID()}`;
  const state = { scopes: [...scopes] };
  /** One operator's connection to it; `beforeWrite` holds that operator's Neo4j write (after the lock was taken). */
  const view = (beforeWrite?: () => Promise<void>) => {
    const calls = { reads: 0, writes: 0 };
    const graph: RotationGraph = {
      read: async cypher => {
        calls.reads++;
        if (cypher === GRANT_IDENTITY_CYPHER) {
          return [{ eid: `4:${id}`, _id: id, id: null, username: null, email: null, seedProvenance: null, marked: false,
            platformAdmin: false, org: null, scopes: [...state.scopes], epoch: neo4j.int(0) }];
        }
        if (cypher === GRANT_HOLDERS_CYPHER) return [{ holders: neo4j.int(1) }];
        if (cypher === SCOPE_MARKERS_CYPHER) return [{ grantedMs: null, revokedMs: null }];
        throw new Error('unexpected read');
      },
      write: async (_cypher, params) => {
        calls.writes++;
        await beforeWrite?.();
        // The statements' compare-and-set: writes only while the list is the one the resolution observed.
        if (JSON.stringify(state.scopes) !== JSON.stringify(params['observed'])) return [{ n: neo4j.int(0) }];
        state.scopes = params['scopes'] as string[];
        return [{ n: neo4j.int(1) }];
      },
    };
    return { graph, calls };
  };
  return { id, state, view };
}

async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** Backends waiting on a scope lock (class 2129, the two-integer advisory form). */
const waitingOnScopeLock = async (): Promise<number> => Number((await monitor.query(
  `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = 2129 AND objsubid = 2 AND NOT granted`)).rows[0].n);
const rowsOf = async (userId: string) => (await monitor.query(
  `SELECT event, actor, occurred_at FROM auth_credential_events WHERE user_id = $1 ORDER BY occurred_at, id`, [userId])).rows;
const within = <T>(work: Promise<T>, what: string, ms = 10_000): Promise<T> => Promise.race([
  work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms)),
]);

describe('the per-user scope lock on a real PostgreSQL', () => {
  it('serialises two runs on one user: the second waits at the lock without touching Neo4j, and the rows follow the order of the Neo4j changes', async () => {
    const user = memoryUser([PORTFOLIO_IMPORT_SCOPE]);
    const gate = deferred();
    const first = user.view(() => gate.promise);
    const second = user.view();
    const reached = first.calls;

    const revoke = revokePortfolioImportScope(first.graph, operator().sql, user.id, 'alice');
    await until(async () => reached.writes === 1, 'the first run to reach its Neo4j write while holding the lock');
    const grant = grantPortfolioImportScope(second.graph, operator().sql, user.id, 'bob');
    await until(async () => (await waitingOnScopeLock()) >= 1, 'the second run to wait on the advisory lock');

    expect(second.calls).toEqual({ reads: 0, writes: 0 });
    expect(await rowsOf(user.id)).toEqual([]);
    const [{ released }] = (await monitor.query(`SELECT clock_timestamp() AS released`)).rows;
    gate.resolve();
    const [revoked, granted] = await within(Promise.all([revoke, grant]), 'both runs');

    // The second run read the user only after the first one's change committed, so it saw the scope gone and granted it.
    expect([revoked.outcome, granted.outcome]).toEqual(['revoked', 'granted']);
    expect(user.state.scopes).toEqual([PORTFOLIO_IMPORT_SCOPE]);
    const rows = await rowsOf(user.id);
    expect(rows.map(row => [row.event, row.actor])).toEqual([
      ['portfolio_import_scope_revoked', 'window-script:alice'], ['portfolio_import_scope_granted', 'window-script:bob'],
    ]);
    // occurred_at is the insert's time, not the transaction's start: the waiting run began before the release.
    expect(rows[1].occurred_at.getTime()).toBeGreaterThanOrEqual(released.getTime());
    expect(rows[0].occurred_at.getTime()).toBeLessThan(rows[1].occurred_at.getTime());
  });

  it('does not make different users wait for each other', async () => {
    const held = memoryUser([PORTFOLIO_IMPORT_SCOPE]);
    const other = memoryUser([PORTFOLIO_IMPORT_SCOPE]);
    const gate = deferred();
    const holding = held.view(() => gate.promise);

    const slow = revokePortfolioImportScope(holding.graph, operator().sql, held.id, 'alice');
    await until(async () => holding.calls.writes === 1, 'the first run to hold its lock at the Neo4j write');
    const free = await within(revokePortfolioImportScope(other.view().graph, operator().sql, other.id, 'bob'), 'the run on another user');

    expect(free.outcome).toBe('revoked');
    expect(await waitingOnScopeLock()).toBe(0);
    gate.resolve();
    expect((await within(slow, 'the held run')).outcome).toBe('revoked');
  });

  it('frees the lock when a run refuses or finishes, so the next run on the user is not blocked', async () => {
    const user = memoryUser([]);

    // A record that does not match the live state refuses with no row...
    await expect(within(recordPortfolioImportScope(user.view().graph, operator().sql, user.id, 'alice', true), 'the refused record'))
      .rejects.toBeInstanceOf(GrantRefused);
    expect(await rowsOf(user.id)).toEqual([]);
    // ...and does not leave the user locked.
    expect((await within(grantPortfolioImportScope(user.view().graph, operator().sql, user.id, 'alice'), 'the grant')).outcome).toBe('granted');
    const recorded = await within(recordPortfolioImportScope(user.view().graph, operator().sql, user.id, 'alice', true), 'the record');
    expect([recorded.outcome, recorded.alreadyRecorded]).toEqual(['granted', false]);
    // HAP-2131: the recovery row has the event of the real one and its own actor marker; a retry appends nothing.
    const retried = await within(recordPortfolioImportScope(user.view().graph, operator().sql, user.id, 'bob', true), 'the retried record');
    expect([retried.eventId, retried.alreadyRecorded]).toEqual([recorded.eventId, true]);
    expect((await rowsOf(user.id)).map(row => [row.event, row.actor])).toEqual([
      ['portfolio_import_scope_granted', 'window-script:alice'], ['portfolio_import_scope_granted', 'window-script-record:alice'],
    ]);
  });

  it('two concurrent record runs on one user append one recovery row: the second, queued at the lock, finds the first', async () => {
    const user = memoryUser([PORTFOLIO_IMPORT_SCOPE]);
    const gate = deferred();
    let entered = false;
    const first = user.view();
    const holding: RotationGraph = {
      read: async (cypher, params) => { entered = true; await gate.promise; return first.graph.read(cypher, params); },
      write: first.graph.write,
    };

    const a = recordPortfolioImportScope(holding, operator().sql, user.id, 'alice', true);
    await until(async () => entered, 'the first record to read the user while holding the lock');
    const b = recordPortfolioImportScope(user.view().graph, operator().sql, user.id, 'bob', true);
    await until(async () => (await waitingOnScopeLock()) >= 1, 'the second record to wait on the advisory lock');
    expect(await rowsOf(user.id)).toEqual([]);
    gate.resolve();
    const [recordedA, recordedB] = await within(Promise.all([a, b]), 'both records');

    expect([recordedA.alreadyRecorded, recordedB.alreadyRecorded]).toEqual([false, true]);
    expect(recordedB.eventId).toBe(recordedA.eventId);
    expect((await rowsOf(user.id)).map(row => [row.event, row.actor])).toEqual([['portfolio_import_scope_granted', 'window-script-record:alice']]);
  });

  it('refuses before any Neo4j access when PostgreSQL cannot be connected to', async () => {
    const user = memoryUser([PORTFOLIO_IMPORT_SCOPE]);
    const view = user.view();
    const unreachable = operator({ CMDB_ROTATE_POSTGRES_PORT: '1' });

    await expect(revokePortfolioImportScope(view.graph, unreachable.sql, user.id, 'alice')).rejects.toBeInstanceOf(ScopeLockUnavailable);

    expect(view.calls).toEqual({ reads: 0, writes: 0 });
    expect(user.state.scopes).toEqual([PORTFOLIO_IMPORT_SCOPE]);
  });
});
