// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// FD17-S2: migration 005 makes CI.external_id unique per organization, on the integration neo4j:5.15.0.
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import neo4j, { Driver } from 'neo4j-driver';

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
  afterAll(async () => {
    // Leave the schema the integration global setup creates: the composite only.
    await run("MATCH (c:CI) WHERE c.id STARTS WITH 'fd17-s2-' DETACH DELETE c");
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
});
