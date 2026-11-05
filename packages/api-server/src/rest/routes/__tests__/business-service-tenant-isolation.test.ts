// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1422 (PoR S1, brief §6 A1/N1): every business-service route is tenant-isolated, proven under the app login.
 * The route-table negative controls are fixtures/business-service-a1.ts; this suite runs them on PGlite.
 *
 * Every statement the routes send runs as `cmdb_user` (NOSUPERUSER, owns no table); see fixtures/app-login.ts. The
 * schema is built by the NOSUPERUSER owner `cmdb_owner` from 001's CREATE TABLE blocks, 008, 011, 028's journal
 * tables, 003, 043 and 046 (service_offerings), then the app grants and 044. Substitutions: Neo4jAuthRepository ->
 * in-memory users; Neo4j -> a graph fake that knows which tenant owns each CI.
 */

import { fork } from 'child_process';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';

// Placeholder config so loadConfig() validates; no Neo4j/Redis/PostgreSQL server is contacted.
// The signing and audit-chain keys are generated per run in memory; no literal credential.
Object.assign(process.env, {
  JWT_SECRET: randomBytes(32).toString('hex'), AUDIT_CHAIN_KEY: randomBytes(32).toString('hex'),
  NEO4J_URI: 'bolt://127.0.0.1:1', NEO4J_USERNAME: 'unused', NEO4J_PASSWORD: 'unused',
  POSTGRES_HOST: '127.0.0.1', POSTGRES_DB: 'unused', POSTGRES_USER: 'unused', POSTGRES_PASSWORD: 'unused',
  REDIS_HOST: '127.0.0.1', KAFKA_CLIENT_ID: 'unused', KAFKA_GROUP_ID: 'unused',
});

const host = fork(join(__dirname, 'fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error, code }: { id: number; rows: unknown[]; error?: string; code?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(Object.assign(new Error(error), { code }));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<unknown[]> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    host.send({ id, op, sql, params });
  });
}
const db = {
  exec: (sql: string) => send('exec', sql),
  rows: <T>(sql: string, params: unknown[] = []) => send('query', sql, params) as Promise<T[]>,
};
const pgClient = {
  query: async (sql: string, params: unknown[] = []) => {
    assertAppStatement(sql);
    return { rows: await send('query', sql, params) };
  },
  getClient: async () => ({ query: pgClient.query, release: () => undefined }),
  pool: { connect: async () => ({ query: pgClient.query, release: () => undefined }) },
  transaction: async <T>(callback: (client: { query: typeof pgClient.query }) => Promise<T>): Promise<T> => {
    await send('exec', 'BEGIN');
    try {
      const result = await callback(pgClient);
      await send('exec', 'COMMIT');
      return result;
    } catch (error) {
      await send('exec', 'ROLLBACK');
      throw error;
    }
  },
};

jest.mock('@cmdb/database', () => {
  const traversal = jest.requireActual<Record<string, unknown>>('@cmdb/database/neo4j/client');
  const audit = jest.requireActual<Record<string, unknown>>('@cmdb/database/postgres/audit.service');
  return {
    ...jest.requireActual<object>('@cmdb/database/journal/journal'),
    isStorableString: jest.requireActual<Record<string, unknown>>('@cmdb/database/journal/encoding')['isStorableString'],
    appendAuditEntry: audit['appendAuditEntry'],
    auditChainReady: audit['auditChainReady'],
    CITraversalLimitError: traversal['CITraversalLimitError'],
    createCITraversalWork: traversal['createCITraversalWork'],
    MAX_CI_TRAVERSAL_NODES: traversal['MAX_CI_TRAVERSAL_NODES'],
    MAX_CI_TRAVERSAL_WORK: traversal['MAX_CI_TRAVERSAL_WORK'],
    CI_TRAVERSAL_QUERY_TIMEOUT_MS: traversal['CI_TRAVERSAL_QUERY_TIMEOUT_MS'],
    getPostgresClient: () => pgClient,
    getNeo4jClient: () => a1GraphClient,
    getAuditService: () => ({}),
  };
});
// bcrypt's native binding is only used for password hashing/login, which token verification never calls.
jest.mock('bcrypt', () => ({}));
jest.mock('../../../auth/neo4j-auth.repository', () => ({
  Neo4jAuthRepository: jest.fn(() => ({
    findUserById: async (userId: string) => A1_USERS[userId] ?? null,
    findApiKeyByKey: async () => null,
  })),
}));

// Imported after mocks are registered (jest hoists jest.mock).
import { loadConfig } from '@cmdb/common';
import { JWTService } from '../../../auth/jwt.service';
import { getAuthMiddleware } from '../../../auth/auth-bootstrap';
import { businessServiceRoutes } from '../business-service.routes';
import { serviceOfferingRoutes } from '../service-offering.routes';
import {
  APP_GRANTS_SQL, APP_LOGIN, AppLoginRefused, assertAppLogin, assertAppStatement, asTableOwner, createLoginRolesSql,
  ENTER_APP_LOGIN_SQL, journalReadAclSql, migrationSql, PGLITE_SUPERUSER, TABLE_OWNER,
} from './fixtures/app-login';
import {
  A1_SEED_SQL, A1_SEEDED_TABLES, A1_TRUNCATE_SQL, A1_USERS, a1GraphClient, defineA1RouteSuite, T,
} from './fixtures/business-service-a1';

const app = express();
app.use(express.json());
app.use('/api/v1', getAuthMiddleware().authenticate());
app.use('/api/v1/business-services', businessServiceRoutes);
app.use('/api/v1/service-offerings', serviceOfferingRoutes);
const jwt = new JWTService(loadConfig().auth.jwt);

beforeAll(async () => {
  const [{ name }] = await db.rows<{ name: string }>('SELECT current_database() AS name');
  const schema = migrationSql('001_complete_schema.sql');
  const ddl = (source: string, table: string) => {
    const match = source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table.replace('.', '\\.')} \\([\\s\\S]*?\\n\\);`));
    if (!match) throw new Error(`DDL for ${table} not found`);
    return match[0];
  };
  await db.exec([createLoginRolesSql(name), 'CREATE SCHEMA cmdb;',
    ...A1_SEEDED_TABLES.filter(table => table !== 'service_offerings').map(table => ddl(schema, table)),
    ...schema.match(/CREATE TYPE audit_\w+ AS ENUM \([^;]*\);/g)!, ddl(schema, 'audit_log')].join('\n'));
  for (const file of ['008_business_service_organization_scope.sql', '011_ci_organization_scope.sql']) {
    await db.exec(`BEGIN;\n${migrationSql(file)}\nCOMMIT;`);
  }
  const journal = migrationSql('028_change_history_reconciliation_org_provenance.sql');
  await db.exec([ddl(journal, 'ci_reconciliation_operations'), ddl(journal, 'ci_reconciliation_epochs'),
    migrationSql('003_audit_hash_chain.sql'), 'ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS organization_id UUID;'].join('\n'));
  for (const file of ['043_business_service_record_c1.sql', '046_service_offerings.sql']) {
    await db.exec(`BEGIN;\n${migrationSql(file)}\nCOMMIT;`);
  }
  await db.exec(APP_GRANTS_SQL + journalReadAclSql() + ENTER_APP_LOGIN_SQL);
}, 60000);
afterAll(() => { host.kill(); });

beforeEach(async () => {
  await asTableOwner(db.exec, () => db.exec(A1_TRUNCATE_SQL + A1_SEED_SQL));
  // Refuse to run a route test unless the session is the app login (A1 setup guard).
  await assertAppLogin(db.rows);
});
// A route that switched the session away from the app login fails its own test.
afterEach(() => assertAppLogin(db.rows));

describe('A1 setup: the routes run as the app login', () => {
  it('current_user and session_user are cmdb_user: rolsuper = false, owner of no relation or schema', async () => {
    expect(await assertAppLogin(db.rows)).toEqual({
      current_user: APP_LOGIN, session_user: APP_LOGIN, rolsuper: false, session_rolsuper: false, rolbypassrls: false,
      rolcreaterole: false,
      has_portfolio: true, owned: [], all_data_roles: [],
    });
    const [owner] = await db.rows<{ owner: string }>(
      "SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = 'public.dim_business_services'::regclass");
    expect(owner).toEqual({ owner: TABLE_OWNER });
  });
});

describe('N1: the setup guard refuses a superuser or table-owner session', () => {
  afterEach(async () => { await db.exec(ENTER_APP_LOGIN_SQL); });

  it('refuses the superuser', async () => {
    await db.exec(`SET SESSION AUTHORIZATION ${PGLITE_SUPERUSER};`);
    const refused = assertAppLogin(db.rows);
    await expect(refused).rejects.toThrow(AppLoginRefused);
    await expect(refused).rejects.toMatchObject({
      reasons: expect.arrayContaining(['current_user postgres is a superuser', 'session_user postgres is a superuser']),
    });
  });

  it('refuses the table owner, which is not a superuser', async () => {
    await db.exec(`SET SESSION AUTHORIZATION ${TABLE_OWNER};`);
    await expect(assertAppLogin(db.rows)).rejects.toMatchObject({
      reasons: [expect.stringMatching(new RegExp(`^${TABLE_OWNER} can act as the owner of \\d+ relations or schemas$`))],
      facts: { rolsuper: false, session_rolsuper: false },
    });
  });

  it('refuses the app role reached by SET ROLE from a superuser session', async () => {
    await db.exec(`SET SESSION AUTHORIZATION ${PGLITE_SUPERUSER}; SET ROLE ${APP_LOGIN};`);
    await expect(assertAppLogin(db.rows)).rejects.toMatchObject({
      reasons: ['session_user postgres is a superuser', 'session_user differs from current_user (SET ROLE)'],
    });
  });
});

defineA1RouteSuite({
  app, router: businessServiceRoutes, offeringRouter: serviceOfferingRoutes, rows: db.rows,
  tokenForT: () => jwt.generateAccessToken('user-t', 'tess', 'operator', T),
});
