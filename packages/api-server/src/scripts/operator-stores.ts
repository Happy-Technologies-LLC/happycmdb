// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Store connections for the HP1-S6 operator scripts (rotate-user-password,
 * identity-window). Connections come only from CMDB_ROTATE_* variables, so
 * an operator script never inherits the API server's credentials or TLS
 * toggles.
 */

// Direct module imports (not the @cmdb/database barrel), as the other operator
// scripts do: the barrel also loads queue/cache clients these scripts never use.
import { Neo4jClient } from '../../../database/src/neo4j/client';
import { PostgresClient } from '../../../database/src/postgres/client';

import type { RotationGraph, RotationLock, RotationSql, Row } from './rotate-user-password';

const LOCK_KEY = 'hp1:credential-rotation';
/** Server-side bound on how long one write transaction can hold its locks. */
const WRITE_TRANSACTION_TIMEOUT_MS = 30_000;

/** Another operator run holds the rotation lock. */
export class LockBusyError extends Error {
  constructor() {
    super('another rotation or reconcile is running');
    this.name = 'LockBusyError';
  }
}

export interface OperatorStores {
  graph: RotationGraph;
  sql: RotationSql;
  lock: RotationLock;
  close(): Promise<void>;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
throw new Error(`${name} is required`);
}
  return value;
}

function graphOf(client: Neo4jClient): RotationGraph {
  return {
    read: async (cypher, params) => {
      const session = client.getSession();
      try {
        return (await session.run(cypher, params)).records.map(record => record.toObject());
      } finally {
        await session.close();
      }
    },
    write: async (cypher, params) => {
      const session = client.getSession();
      const tx = session.beginTransaction({ timeout: WRITE_TRANSACTION_TIMEOUT_MS });
      try {
        const rows = (await tx.run(cypher, params)).records.map(record => record.toObject());
        await tx.commit();
        return rows;
      } catch (error) {
        if (tx.isOpen()) {
await tx.rollback().catch(() => undefined);
}
        throw error;
      } finally {
        await session.close();
      }
    },
  };
}

/** pg returns rows as `any[]`; keep only object rows (every SELECT/RETURNING row is one). */
function asRows(rows: unknown[]): Row[] {
  return rows.filter((row): row is Row => typeof row === 'object' && row !== null);
}

function sqlOf(client: PostgresClient): RotationSql {
  return {
    query: async (text, params) => ({ rows: asRows((await client.query(text, params)).rows as unknown[]) }),
    transaction: async callback => {
      const connection = await client.getClient();
      try {
        await connection.query('BEGIN');
        const result = await callback({
          query: async (text, params) => ({ rows: asRows((await connection.query(text, params)).rows as unknown[]) }),
        });
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        connection.release();
      }
    },
  };
}

/** The pooled connection that holds the session advisory lock. */
interface LockConnection {
  query(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  release(error?: Error | boolean): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * pg_try_advisory_lock on one dedicated connection held for the whole run.
 * If that session is lost (terminated, network), the lock is gone too; the
 * run carries on safely because no outcome depends on the lock, and the
 * broken connection is discarded instead of crashing the process.
 */
function lockOf(client: PostgresClient): RotationLock {
  let connection: LockConnection | undefined;
  let lost = false;
  const onError = (): void => {
    lost = true;
  };
  const giveBack = (held: LockConnection, error?: Error | boolean): void => {
    held.removeListener('error', onError);
    held.release(error);
  };
  return {
    acquire: async () => {
      const acquired: LockConnection = await client.getClient();
      lost = false;
      acquired.on('error', onError);
      const { rows } = await acquired.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [LOCK_KEY]);
      if (rows[0]?.['locked'] !== true) {
        giveBack(acquired);
        throw new LockBusyError();
      }
      connection = acquired;
    },
    release: async () => {
      const held = connection;
      connection = undefined;
      if (held === undefined) {
return;
}
      if (lost) {
        giveBack(held, true);
        return;
      }
      try {
        await held.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [LOCK_KEY]);
        giveBack(held);
      } catch (error) {
        giveBack(held, error instanceof Error ? error : true);
      }
    },
  };
}

export function openOperatorStores(env: NodeJS.ProcessEnv): OperatorStores {
  const port = Number(required(env, 'CMDB_ROTATE_POSTGRES_PORT'));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
throw new Error('CMDB_ROTATE_POSTGRES_PORT must be a TCP port');
}
  const sslSetting = env['CMDB_ROTATE_POSTGRES_SSL'];
  const ssl: 'require' | 'verify-full' | false = sslSetting === 'require' || sslSetting === 'verify-full' ? sslSetting : false;
  if (sslSetting !== undefined && ssl === false) {
throw new Error('CMDB_ROTATE_POSTGRES_SSL must be require or verify-full when set');
}
  const encrypted = env['CMDB_ROTATE_NEO4J_ENCRYPTED'];
  if (encrypted !== undefined && encrypted !== 'true' && encrypted !== 'false') {
    throw new Error('CMDB_ROTATE_NEO4J_ENCRYPTED must be true or false when set');
  }
  const postgres = new PostgresClient({
    _host: required(env, 'CMDB_ROTATE_POSTGRES_HOST'), _port: port, _database: required(env, 'CMDB_ROTATE_POSTGRES_DB'),
    _user: required(env, 'CMDB_ROTATE_POSTGRES_USER'), _password: required(env, 'CMDB_ROTATE_POSTGRES_PASSWORD'), ssl,
  });
  const graph = new Neo4jClient(
    required(env, 'CMDB_ROTATE_NEO4J_URI'), required(env, 'CMDB_ROTATE_NEO4J_USERNAME'),
    required(env, 'CMDB_ROTATE_NEO4J_PASSWORD'), { encrypted: encrypted === 'true' }
  );
  return {
    graph: graphOf(graph), sql: sqlOf(postgres), lock: lockOf(postgres),
    close: async () => {
      await postgres.close();
      await graph.close();
    },
  };
}

/** Drops the API server's own TLS toggles so only CMDB_ROTATE_* defines connections. */
export function isolateOperatorEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of ['POSTGRES_SSL_MODE', 'POSTGRES_SSL_ENABLED', 'NEO4J_SSL_ENABLED', 'NEO4J_ENCRYPTION', 'NEO4J_SSL_TRUST_STRATEGY']) {
    delete env[name];
  }
}
