// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// FD17-S2: migration 005 makes CI.external_id unique per organization, on the integration neo4j:5.15.0.
// FD17-S3: REST create accepts external_id behind the schema gate, with real PostgreSQL and Neo4j.
// FD17-S4: GET /cis?external_id= on real Neo4j (#137 verification LOW-1: the unit fake cannot see an OR in the WHERE).
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import neo4j, { Driver } from 'neo4j-driver';
import { getPostgresClient } from '@cmdb/database';
import { ciRoutes } from '../../src/rest/routes/ci.routes';
import type { TokenPayload } from '../../src/auth/types';

const NEO4J_DIR = join(__dirname, '../../../database/src/neo4j');
const MIGRATION = join(NEO4J_DIR, 'migrations/005_ci_external_id_org_unique.cypher');
const INITIALIZERS: Array<[string, string]> = [
  ['init-neo4j.cypher', join(__dirname, '../../../../infrastructure/scripts/init-neo4j.cypher')],
  ['schema.cypher', join(NEO4J_DIR, 'schema.cypher')],
];
const COMPOSITE = 'CREATE CONSTRAINT ci_org_external_id_unique IF NOT EXISTS FOR (ci:CI) REQUIRE (ci.organization_id, ci.external_id) IS UNIQUE';
const GLOBAL = 'CREATE CONSTRAINT ci_external_id_unique IF NOT EXISTS FOR (ci:CI) REQUIRE ci.external_id IS UNIQUE';
const COMPOSITE_ONLY = [{ name: 'ci_org_external_id_unique', properties: ['organization_id', 'external_id'] }];
const [ORG_A, ORG_B] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const [A, B, C] = [randomUUID(), randomUUID(), randomUUID()]; // FD17-S3 REST orgs, fresh per run

/** Statements as cypher-shell -f reads them: comment lines dropped, split on ';', whitespace collapsed. */
const statements = (file: string): string[] => readFileSync(file, 'utf8')
  .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
  .split(';').map(statement => statement.replace(/\s+/g, ' ').trim()).filter(statement => statement !== '');

it('005 creates the composite before it drops the global constraint, and nothing else', () => {
  expect(statements(MIGRATION)).toEqual([COMPOSITE, 'DROP CONSTRAINT ci_external_id_unique IF EXISTS']);
});

it('db-init.sh fallback creates the composite and not the global constraint', () => {
  const fallback = readFileSync(join(__dirname, '../../../../scripts/db-init.sh'), 'utf8').match(/"CREATE CONSTRAINT [^"]*external_id[^"]*"/g);
  expect(fallback).toEqual([`"${COMPOSITE}"`]);
});

describe('on the integration Neo4j', () => {
  let driver: Driver;
  const run = async (cypher: string, params: Record<string, unknown> = {}) => {
    const session = driver.session();
    try { return await session.run(cypher, params); } finally { await session.close(); }
  };
  /** Every uniqueness constraint on :CI that covers external_id. */
  const externalIdConstraints = async () => (await run(`SHOW CONSTRAINTS YIELD name, type, labelsOrTypes, properties
    WHERE type CONTAINS 'UNIQUENESS' AND labelsOrTypes = ['CI'] AND 'external_id' IN properties
    RETURN name, properties ORDER BY name`)).records.map(record => record.toObject());
  const ci = (org: string, externalId: string) =>
    run('CREATE (:CI {id: $id, organization_id: $org, external_id: $externalId})', { id: `fd17-s2-${randomUUID()}`, org, externalId });
  /** Applies 005 statement by statement; returns the summed constraint counters. */
  const apply005 = async () => {
    const total = { added: 0, removed: 0 };
    for (const statement of statements(MIGRATION)) {
      const { constraintsAdded, constraintsRemoved } = (await run(statement)).summary.counters.updates();
      total.added += constraintsAdded; total.removed += constraintsRemoved;
    }
    return total;
  };

  beforeAll(() => { driver = neo4j.driver(process.env.NEO4J_URI!, neo4j.auth.basic(process.env.NEO4J_USERNAME || 'neo4j', process.env.NEO4J_PASSWORD!)); });
  // No test leaves a shared external_id behind: a later global constraint creation would fail on it.
  afterEach(() => run("MATCH (c:CI) WHERE c.id STARTS WITH 'fd17-s2-' OR c.organization_id IN $orgs DETACH DELETE c", { orgs: [A, B, C] }));
  afterAll(async () => {
    // Leave the schema the integration global setup creates: the composite only.
    await run('DROP CONSTRAINT ci_external_id_unique IF EXISTS');
    await run(COMPOSITE);
    await driver.close();
  });

  it('the integration global setup creates the composite and no global constraint', async () => {
    expect(await externalIdConstraints()).toEqual(COMPOSITE_ONLY);
  });

  it.each(INITIALIZERS)('%s never drops and creates only the composite on CI(external_id)', async (_name, file) => {
    const own = statements(file);
    expect(own.filter(statement => /^DROP\b/i.test(statement))).toEqual([]);
    await run('DROP CONSTRAINT ci_org_external_id_unique IF EXISTS');
    for (const statement of own.filter(s => /^CREATE CONSTRAINT .* FOR \(\w+:CI\)/i.test(s))) await run(statement);
    expect(await externalIdConstraints()).toEqual(COMPOSITE_ONLY);
  });

  it('005 on a database with the global constraint: per-org uniqueness, then a no-op re-apply', async () => {
    await run('DROP CONSTRAINT ci_org_external_id_unique IF EXISTS');
    await run(GLOBAL);
    expect(await apply005()).toEqual({ added: 1, removed: 1 });
    expect(await externalIdConstraints()).toEqual(COMPOSITE_ONLY);
    // Orgs A and B both commit the same external_id; a second one in A is rejected.
    const externalId = `fd17-s2-ext-${randomUUID()}`;
    await ci(ORG_A, externalId);
    await ci(ORG_B, externalId);
    expect((await run('MATCH (c:CI {external_id: $externalId}) RETURN collect(c.organization_id) AS orgs', { externalId })).records[0].get('orgs').sort()).toEqual([ORG_A, ORG_B]);
    await expect(ci(ORG_A, externalId)).rejects.toMatchObject({ code: 'Neo.ClientError.Schema.ConstraintValidationFailed' });
    expect(await apply005()).toEqual({ added: 0, removed: 0 });
    expect(await externalIdConstraints()).toEqual(COMPOSITE_ONLY);
  });

  describe('REST POST /cis with external_id (FD17-S3)', () => {
    const app = express().use(express.json()).use((req, _res, next) => {
      // An authenticated operator of the org the test names; JWT verification is not under test here.
      (req as express.Request & { user?: TokenPayload }).user = { _userId: 'fd17-s3', _username: 'fd17-s3',
        _role: 'operator', _type: 'access', _organizationId: req.header('x-org')! };
      next();
    }).use('/api/v1/cis', ciRoutes);
    const post = (org: string, externalId: string) => request(app).post('/api/v1/cis').set('x-org', org)
      .send({ name: 'fd17-s3', type: 'server', external_id: externalId });
    const [ext1, unused] = [`fd17-s3-${randomUUID()}`, `fd17-s3-${randomUUID()}`];

    it('un-migrated (a global external_id constraint): 503 identical for a used and an unused value, no journal row', async () => {
      await run('CREATE (:CI:Server {id: $id, organization_id: $A, external_id: $ext1})', { id: `fd17-s3-${randomUUID()}`, A, ext1 });
      try {
        for (const dropComposite of [false, true]) { // with 005's composite (an initializer re-run), then without it
          await run(GLOBAL);
          if (dropComposite) await run('DROP CONSTRAINT ci_org_external_id_unique IF EXISTS');
          const [used, free] = [await post(B, ext1), await post(B, unused)];
          expect([used.status, used.body, free.status, free.text]).toEqual([503,
            { success: false, error: 'Service Unavailable', message: 'CI write temporarily unavailable' }, 503, used.text]);
        }
        expect((await getPostgresClient().query('SELECT count(*)::int AS n FROM ci_reconciliation_operations WHERE organization_id = $1', [B])).rows[0].n).toBe(0);
        // The journal itself is ready: the same create without external_id commits.
        expect((await request(app).post('/api/v1/cis').set('x-org', C).send({ name: 'fd17-s3', type: 'server' })).status).toBe(201);
      } finally {
        await run('DROP CONSTRAINT ci_external_id_unique IF EXISTS');
        await run(COMPOSITE);
      }
    });

    it('after 005: one value in two orgs, identical answers for a used and an unused value, value-free same-org 409', async () => {
      expect(await externalIdConstraints()).toEqual(COMPOSITE_ONLY);
      const [a, b] = [await post(A, ext1), await post(B, ext1)];
      expect([a.status, a.body.data.external_id, b.status, b.body.data.external_id]).toEqual([201, ext1, 201, ext1]);
      expect(b.body.data.id).not.toBe(a.body.data.id);
      const [used, free] = [await post(C, ext1), await post(C, unused)];
      const [usedShape, freeShape] = [used, free].map(res => [res.status, res.body.message, Object.keys(res.body.data).sort()]);
      expect([used.status, usedShape]).toEqual([201, freeShape]);
      const again = await post(A, ext1);
      expect([again.status, again.body]).toEqual([409, { success: false, error: 'Conflict', message: 'CI could not be reconciled' }]);
      expect((await run('MATCH (c:CI {organization_id: $A}) RETURN count(c) AS n', { A })).records[0]!.get('n').toNumber()).toBe(1);
      // Immutable after create (D17-3): PUT strips it.
      const put = await request(app).put(`/api/v1/cis/${a.body.data.id}`).set('x-org', A).send({ name: 'renamed', external_id: unused });
      expect([put.status, put.body.data.name, put.body.data.external_id]).toEqual([200, 'renamed', ext1]);
    });

    it('FD17-S4 GET ?external_id=: the own exact CI only; one identical empty answer for a foreign and an unused value', async () => {
      const [a, b] = [await post(A, ext1), await post(B, ext1)];
      expect([a.status, b.status]).toEqual([201, 201]);
      const get = (org: string, externalId: string) => request(app).get('/api/v1/cis').query({ external_id: externalId }).set('x-org', org);
      const own = await get(A, ext1);
      expect([own.status, own.body.data.map((ci: { id: string }) => ci.id), own.body.pagination.total]).toEqual([200, [a.body.data.id], 1]);
      // ' OR ci.external_id = $externalId' in the controller would return A's and B's CIs to C here.
      const [used, free] = [await get(C, ext1), await get(C, unused)];
      expect([used.status, used.body.data, used.body.pagination.total, used.text]).toEqual([200, [], 0, free.text]);
    });
  });
});
