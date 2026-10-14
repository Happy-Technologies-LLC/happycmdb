// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HP1-S6 user identity resolution on real Neo4j 5.15 and PostgreSQL
 * (approvals/cmdb-pr50-sec12-02-user-id-index-scope-a-AMENDMENT.go):
 * - an identifier resolves to exactly ONE distinct :User node across `_id`
 *   and `id` (and `_username`/`username`). Zero matches is not found; more
 *   than one is refused (fail closed). There is no first-row, spelling
 *   preference, ORDER or LIMIT.
 * - the same matrix runs WITH neo4j migration 003 (user_id_lookup) and
 *   WITHOUT it. Allow/deny and the principal are identical; only speed
 *   differs.
 * - mutations (updateUser, updateUserLastLogin) write nothing on an
 *   ambiguous identifier.
 * - with 003 the lookup statement seeks an index for BOTH spellings and never
 *   scans :User.
 * The cross-node `_id`/`id` collision is the PRE-EXISTING HIGH this change
 * closes: the base loader returned an arbitrary records[0].
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import neo4j, { Driver } from 'neo4j-driver';
import { join } from 'path';
import { Pool } from 'pg';

import { AuthFailureError, AuthService } from '../../../packages/api-server/src/auth/auth.service';
import { JWTService } from '../../../packages/api-server/src/auth/jwt.service';
import { FIND_USER_BY_ID_CYPHER, Neo4jAuthRepository } from '../../../packages/api-server/src/auth/neo4j-auth.repository';
import { AmbiguousUserIdentityError } from '../../../packages/api-server/src/auth/types';

const authConfig = {
  jwt: { secret: 'identity-resolution-secret-at-least-32-chars', accessTokenExpiresIn: '1h', refreshTokenExpiresIn: '7d', issuer: 'idr', audience: 'idr' },
  bcrypt: { rounds: 4 },
  apiKeys: { enabled: true, headerName: 'X-API-Key' },
};
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const MIGRATION_003 = join(__dirname, '../../../packages/database/src/neo4j/migrations/003_user_id_lookup_index.cypher');
const PASSWORD = 'identity-resolution-pw';

/** label → node properties. Labels name the expected principal. */
const FIXTURES: Record<string, Record<string, unknown>> = {
  'id-underscore-only': { _id: 'idr-u1', _username: 'idr-u1', _role: 'operator', _organizationId: ORG_A },
  'id-plain-only': { id: 'idr-u2', username: 'idr-u2', role: 'viewer', organizationId: ORG_B },
  'equal-aliases': { _id: 'idr-u3', id: 'idr-u3', _username: 'idr-u3', _role: 'operator', _organizationId: ORG_A },
  'different-aliases': { _id: 'idr-u4a', id: 'idr-u4b', _username: 'idr-u4', _role: 'admin', _organizationId: ORG_A },
  'duplicate-underscore-1': { _id: 'idr-dup', _username: 'idr-dup-1', _role: 'operator', _organizationId: ORG_A },
  'duplicate-underscore-2': { _id: 'idr-dup', _username: 'idr-dup-2', _role: 'admin', _organizationId: ORG_B },
  'cross-node-underscore': { _id: 'idr-x', _username: 'idr-x-1', _role: 'viewer', _organizationId: ORG_A },
  'cross-node-plain': { id: 'idr-x', username: 'idr-x-2', role: 'admin', organizationId: ORG_B },
  'username-underscore': { _id: 'idr-n1', _username: 'idr-name', _role: 'viewer', _organizationId: ORG_A },
  'username-plain': { id: 'idr-n2', username: 'idr-name', role: 'viewer', organizationId: ORG_A },
};
/** Lookup identifiers and the principal each must resolve to (label), or null / 'ambiguous'. */
const LOOKUPS: Array<[string, string | null]> = [
  ['idr-missing', null],
  ['idr-u1', 'id-underscore-only'],
  ['idr-u2', 'id-plain-only'],
  ['idr-u3', 'equal-aliases'],
  ['idr-u4a', 'different-aliases'],
  ['idr-u4b', 'different-aliases'],
  ['idr-dup', 'ambiguous'],
  ['idr-x', 'ambiguous'],
];

let driver: Driver;
let pool: Pool;
let service: AuthService;
let repository: Neo4jAuthRepository;
let jwt: JWTService;
const labelOf = new Map<string, string>();

async function cypher(statement: string, params: Record<string, unknown> = {}) {
  const session = driver.session();
  try {
    return await session.run(statement, params);
  } finally {
    await session.close();
  }
}
const keyOf = (id: string) => `idr-key-${id}`;
const keyHash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const reason = (error: unknown) => (error instanceof AuthFailureError ? error.reason : error instanceof Error ? error.name : String(error));

const INIT_NEO4J = join(__dirname, '../../../infrastructure/scripts/init-neo4j.cypher');
const cypherStatements = (text: string) => text.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  .split(';').map(s => s.trim()).filter(Boolean);

/**
 * The integration global setup does not load init-neo4j.cypher, so this
 * suite creates the fresh-install :User lookup schema itself: the
 * user_id_unique constraint taken verbatim from init-neo4j.cypher (it backs
 * `id` on every deployed database), and migration 003 for `_id`.
 */
async function ensureUserIdUnique(): Promise<void> {
  const statement = cypherStatements(readFileSync(INIT_NEO4J, 'utf8')).find(s => s.startsWith('CREATE CONSTRAINT user_id_unique'));
  await cypher(statement!);
}
async function apply003(): Promise<void> {
  for (const statement of cypherStatements(readFileSync(MIGRATION_003, 'utf8'))) await cypher(statement);
  await cypher('CALL db.awaitIndexes(300)');
}
/** Names of the schema objects present before this suite, restored afterwards. */
const preexisting = { constraint: false, index: false };
async function schemaPresent() {
  const constraint = await cypher("SHOW CONSTRAINTS YIELD name WHERE name = 'user_id_unique' RETURN count(*) AS n");
  const index = await cypher("SHOW INDEXES YIELD name WHERE name = 'user_id_lookup' RETURN count(*) AS n");
  return { constraint: neo4j.integer.toNumber(constraint.records[0]!.get('n')) > 0, index: neo4j.integer.toNumber(index.records[0]!.get('n')) > 0 };
}

/** Every observable outcome of every lookup, in one run. */
async function observe() {
  const outcomes: Record<string, unknown> = {};
  for (const [id] of LOOKUPS) {
    const repo = await repository.findUserById(id).then(
      user => (user === null ? 'not_found' : labelOf.get(user._elementId!)),
      error => (error instanceof AmbiguousUserIdentityError ? 'ambiguous' : `error:${String(error)}`)
    );
    const bearer = await service.verifyToken(jwt.generateAccessToken(id, id, 'admin', ORG_A)).then(
      p => ({ allow: true, userId: p._userId, role: p._role, org: p._organizationId ?? null }), e => ({ allow: false, reason: reason(e) })
    );
    const refresh = await service.refreshToken({ refreshToken: jwt.generateRefreshToken(id, id, 'admin') }).then(
      r => ({ allow: true, userId: r._user._id, role: r._user._role }), e => ({ allow: false, reason: reason(e) })
    );
    const apiKey = await service.verifyApiKey(keyOf(id)).then(
      p => ({ allow: true, userId: p._userId, role: p._role, org: p._organizationId ?? null }), e => ({ allow: false, reason: reason(e) })
    );
    outcomes[id] = { repo, bearer, refresh, apiKey };
  }
  outcomes['login:idr-name'] = await service.login({ username: 'idr-name', password: PASSWORD }).then(
    () => ({ allow: true }), e => ({ allow: false, reason: reason(e) })
  );
  return outcomes;
}

/** updateUser and updateUserLastLogin on ambiguous identifiers: refused, and no node written. */
async function mutationsOnAmbiguity() {
  const results: Record<string, unknown> = {};
  for (const id of ['idr-dup', 'idr-x']) {
    results[`updateUser:${id}`] = await repository.updateUser(id, { name: 'idr-mutated' }).then(() => 'written', e => reason(e));
    results[`updateUserLastLogin:${id}`] = await repository.updateUserLastLogin(id).then(() => 'written', e => reason(e));
  }
  const touched = await cypher(
    "MATCH (u:User) WHERE coalesce(u._id, u.id) STARTS WITH 'idr-' AND (u._name = 'idr-mutated' OR u._lastLoginAt IS NOT NULL) RETURN count(u) AS n"
  );
  results['nodesWritten'] = neo4j.integer.toNumber(touched.records[0]!.get('n'));
  return results;
}

beforeAll(async () => {
  driver = neo4j.driver(process.env['NEO4J_URI']!, neo4j.auth.basic(process.env['NEO4J_USERNAME']!, process.env['NEO4J_PASSWORD']!));
  pool = new Pool({ host: process.env['POSTGRES_HOST'], port: Number(process.env['POSTGRES_PORT']), database: process.env['POSTGRES_DB'],
    user: process.env['POSTGRES_USER'], password: process.env['POSTGRES_PASSWORD'] });
  repository = new Neo4jAuthRepository();
  service = new AuthService(authConfig as never, repository);
  jwt = new JWTService(authConfig.jwt as never);
  const hash = await bcrypt.hash(PASSWORD, 4);
  Object.assign(preexisting, await schemaPresent());
  await cypher("MATCH (u:User) WHERE coalesce(u._id, u.id) STARTS WITH 'idr-' DETACH DELETE u");
  await pool.query("DELETE FROM api_keys WHERE user_id LIKE 'idr-%'");
  await ensureUserIdUnique();
  for (const [label, props] of Object.entries(FIXTURES)) {
    const enabled = 'role' in props ? { enabled: true } : { _enabled: true };
    const created = await cypher('CREATE (u:User) SET u = $props RETURN elementId(u) AS e',
      { props: { ...props, ...enabled, _passwordHash: hash } });
    labelOf.set(created.records[0]!.get('e') as string, label);
  }
  for (const [id] of LOOKUPS) {
    await pool.query("INSERT INTO api_keys (user_id, key_hash, name, role) VALUES ($1, $2, 'idr', 'admin')", [id, keyHash(keyOf(id))]);
  }
});

afterAll(async () => {
  // Restore the schema this suite found, so later suites see the CI default.
  if (!preexisting.index) await cypher('DROP INDEX user_id_lookup IF EXISTS');
  else await apply003();
  if (!preexisting.constraint) await cypher('DROP CONSTRAINT user_id_unique IF EXISTS');
  await cypher("MATCH (u:User) WHERE coalesce(u._id, u.id) STARTS WITH 'idr-' DETACH DELETE u");
  await pool?.query("DELETE FROM api_keys WHERE user_id LIKE 'idr-%'");
  await pool?.end();
  await driver?.close();
  await getNeo4jClient().close();
  await getPostgresClient().close();
});

const EXPECTED_PRINCIPALS: Record<string, { userId: string; role: string; org: string | null }> = {
  'idr-u1': { userId: 'idr-u1', role: 'operator', org: ORG_A },
  'idr-u2': { userId: 'idr-u2', role: 'viewer', org: ORG_B },
  'idr-u3': { userId: 'idr-u3', role: 'operator', org: ORG_A },
  'idr-u4a': { userId: 'idr-u4a', role: 'admin', org: ORG_A },
  'idr-u4b': { userId: 'idr-u4a', role: 'admin', org: ORG_A },
};

describe('identity resolution: one distinct node, identical with and without neo4j migration 003', () => {
  let withIndex: Record<string, unknown>;
  let withoutIndex: Record<string, unknown>;
  let mutationsWith: Record<string, unknown>;
  let mutationsWithout: Record<string, unknown>;

  beforeAll(async () => {
    await apply003();
    withIndex = await observe();
    mutationsWith = await mutationsOnAmbiguity();
    await cypher('DROP INDEX user_id_lookup IF EXISTS');
    withoutIndex = await observe();
    mutationsWithout = await mutationsOnAmbiguity();
    await apply003();
  }, 120_000);

  it('both runs give the same allow/deny and principal for every case', () => {
    expect(withoutIndex).toEqual(withIndex);
    expect(mutationsWithout).toEqual(mutationsWith);
  });

  it.each(LOOKUPS)('%s resolves to %s', (id, expected) => {
    const outcome = withIndex[id] as Record<string, Record<string, unknown> | string>;
    if (expected === null || expected === 'ambiguous') {
      const why = expected === null ? 'revoked' : 'ambiguous_identity';
      expect(outcome['repo']).toBe(expected === null ? 'not_found' : 'ambiguous');
      expect(outcome['bearer']).toEqual({ allow: false, reason: why });
      expect(outcome['refresh']).toEqual({ allow: false, reason: why });
      expect(outcome['apiKey']).toEqual({ allow: false, reason: why });
      return;
    }
    const principal = EXPECTED_PRINCIPALS[id]!;
    expect(outcome['repo']).toBe(expected);
    // verifyToken reports the token's own subject; refresh and API keys report the stored _id.
    expect(outcome['bearer']).toEqual({ allow: true, ...principal, userId: id });
    expect(outcome['refresh']).toEqual({ allow: true, userId: principal.userId, role: principal.role });
    expect(outcome['apiKey']).toEqual({ allow: true, ...principal });
  });

  it('a username held by two nodes (both spellings) refuses login', () => {
    expect(withIndex['login:idr-name']).toEqual({ allow: false, reason: 'ambiguous_identity' });
  });

  it('updateUser and updateUserLastLogin refuse ambiguous identifiers and write no node', () => {
    expect(mutationsWith).toEqual({
      'updateUser:idr-dup': 'AmbiguousUserIdentityError', 'updateUserLastLogin:idr-dup': 'AmbiguousUserIdentityError',
      'updateUser:idr-x': 'AmbiguousUserIdentityError', 'updateUserLastLogin:idr-x': 'AmbiguousUserIdentityError',
      nodesWritten: 0,
    });
  });

  it('updateUserLastLogin still writes the single node of an unambiguous identifier', async () => {
    await repository.updateUserLastLogin('idr-u4b');
    const written = await cypher("MATCH (u:User) WHERE u._lastLoginAt IS NOT NULL AND coalesce(u._id, u.id) STARTS WITH 'idr-' RETURN u._id AS id");
    expect(written.records.map(r => r.get('id'))).toEqual(['idr-u4a']);
  });
});

describe('with neo4j migration 003, the per-request lookup seeks an index for BOTH spellings', () => {
  type PlanNode = { operatorType: string; arguments?: Record<string, unknown>; children: PlanNode[] };
  const operators = (node: PlanNode, out: Array<{ operator: string; details: string }> = []) => {
    out.push({ operator: node.operatorType, details: String(node.arguments?.['Details'] ?? '') });
    node.children.forEach(child => operators(child, out));
    return out;
  };

  beforeAll(async () => {
    await apply003();
    await cypher('UNWIND range(0, 1999) AS i CREATE (:User {_id: "idr-fill-" + toString(i), _username: "idr-fill-" + toString(i)})');
  }, 120_000);

  it.each([['an _id value', 'idr-u1'], ['an id value', 'idr-u2']])('PROFILE for %s: index seeks on User(_id) and User(id), no :User label scan', async (_label, id) => {
    const plan = operators((await cypher(`PROFILE ${FIND_USER_BY_ID_CYPHER}`, { id })).summary.profile as unknown as PlanNode);

    expect(plan.map(p => p.operator).join(' ')).not.toMatch(/LabelScan|AllNodesScan/);
    expect(plan.some(p => /IndexSeek/.test(p.operator) && /User\(_id\)/.test(p.details))).toBe(true);
    expect(plan.some(p => /IndexSeek/.test(p.operator) && /User\(id\)/.test(p.details))).toBe(true);
  });
});
