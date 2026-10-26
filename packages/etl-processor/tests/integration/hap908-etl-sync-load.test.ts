// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-908: the incremental `sync` ETL job loads the CIs it selects into
 * cmdb.dim_ci (SCD Type 2), each in its own organization, and reports only
 * the CIs it actually loaded as processed; every other selected CI is failed.
 *
 * Infrastructure: the shared global integration Neo4j and PostgreSQL (env vars
 * exported by the global setup), reached through the `@cmdb/database`
 * singletons that the processor itself uses.
 */

import { randomUUID } from 'crypto';
import type { Job } from 'bullmq';
import { getQueueManager } from '@cmdb/common';
import type { ETLJobData } from '@cmdb/common';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { etlJobProcessor } from '../../src/processors/etl-processor';
import { assertIsolatedIntegrationTarget } from '../../../../tests/setup/isolated-integration-target';
import { deleteOwnedDataMart } from './helpers/owned-data-mart';

// HAP-975: fail at module load, before any hook can reach a database (or wipe its CIs).
assertIsolatedIntegrationTarget();

const ORG_A = 'a9080000-0000-4000-8000-00000000000a';
const ORG_B = 'b9080000-0000-4000-8000-00000000000b';

const RUN = randomUUID();
const A_NEW = `hap908-${RUN}-a-new`;
const B_NEW = `hap908-${RUN}-b-new`;
const A_RENAMED = `hap908-${RUN}-a-renamed`;
const A_OWNED_CLAIMED_BY_B = `hap908-${RUN}-a-owned-claimed-by-b`;
const A_STALE = `hap908-${RUN}-a-stale`;
const OWNED = [A_NEW, B_NEW, A_RENAMED, A_OWNED_CLAIMED_BY_B, A_STALE];

async function cypher(query: string, params: Record<string, unknown> = {}): Promise<string[]> {
  const session = getNeo4jClient().getSession();
  try {
    const result = await session.run(query, params);
    return result.records.map(record => record.get('id') as string);
  } finally {
    await session.close();
  }
}

const sql = (text: string, params: unknown[] = []) => getPostgresClient().query(text, params);

async function clearDataMart(): Promise<void> {
  await deleteOwnedDataMart(sql, OWNED);
}

beforeEach(async () => {
  // The sync query is global over (:CI); clear every CI so only these rows are eligible.
  await cypher('MATCH (c:CI) DETACH DELETE c');
  await clearDataMart();

  // Already in the data mart: one org A CI that has since been renamed, and
  // one org A CI whose node now names org B (a CI never moves organization).
  await sql(`INSERT INTO cmdb.dim_ci
    (ci_id, ci_name, ci_type, ci_status, environment, is_current, organization_id, org_backfilled)
    VALUES ($1, 'original name', 'server', 'active', 'production', TRUE, $3, FALSE),
           ($2, 'org A name', 'server', 'active', 'production', TRUE, $3, FALSE)`,
  [A_RENAMED, A_OWNED_CLAIMED_BY_B, ORG_A]);

  await cypher(
    `UNWIND $rows AS row
     CREATE (:CI {id: row.id, name: row.name, type: 'server', status: 'active',
       environment: 'production', organization_id: row.org,
       discovered_at: datetime() - duration({minutes: row.minutesAgo}),
       created_at: datetime() - duration({minutes: row.minutesAgo}),
       updated_at: datetime() - duration({minutes: row.minutesAgo})})`,
    { rows: [
      { id: A_STALE, name: 'stale', org: ORG_A, minutesAgo: 10 },
      { id: A_NEW, name: 'new in A', org: ORG_A, minutesAgo: 4 },
      { id: B_NEW, name: 'new in B', org: ORG_B, minutesAgo: 3 },
      { id: A_RENAMED, name: 'renamed', org: ORG_A, minutesAgo: 2 },
      { id: A_OWNED_CLAIMED_BY_B, name: 'org B name', org: ORG_B, minutesAgo: 1 },
    ] }
  );
  // Seed control: exactly four CIs are inside the five-minute window.
  expect(await cypher(
    `MATCH (c:CI) WHERE c.updated_at > datetime() - duration({minutes: 5})
     RETURN c.id AS id ORDER BY c.updated_at`
  )).toEqual([A_NEW, B_NEW, A_RENAMED, A_OWNED_CLAIMED_BY_B]);
});

afterAll(async () => {
  await cypher('MATCH (c:CI) DETACH DELETE c');
  await clearDataMart();
  await getNeo4jClient().close();
  await getPostgresClient().close();
  await getQueueManager().closeAll();
});

test('sync loads each selected CI into cmdb.dim_ci in its own organization and counts only loaded CIs as processed', async () => {
  const result = await etlJobProcessor.process({
    id: 'hap908',
    data: { _jobId: 'hap908', _type: 'sync', _config: {}, triggeredBy: 'hap908-test' },
    processedOn: Date.now(),
    updateProgress: async () => undefined,
  } as unknown as Job<ETLJobData>);

  const rows = (await sql(
    `SELECT ci_id, ci_name, organization_id, is_current FROM cmdb.dim_ci
     WHERE ci_id = ANY($1::varchar[]) ORDER BY ci_id, is_current`, [OWNED]
  )).rows;

  expect({
    counts: {
      processed: result._itemsProcessed,
      created: result._itemsCreated,
      updated: result._itemsUpdated,
      failed: result._itemsFailed,
    },
    rows,
  }).toEqual({
    // Four CIs selected: three loaded (two new, one new version), one refused.
    counts: { processed: 3, created: 2, updated: 1, failed: 1 },
    rows: [
      { ci_id: A_NEW, ci_name: 'new in A', organization_id: ORG_A, is_current: true },
      // The node naming org B neither moves org A's CI nor gets a version in org B.
      { ci_id: A_OWNED_CLAIMED_BY_B, ci_name: 'org A name', organization_id: ORG_A, is_current: true },
      // SCD Type 2: the stored version is expired and the rename is the current one.
      { ci_id: A_RENAMED, ci_name: 'original name', organization_id: ORG_A, is_current: false },
      { ci_id: A_RENAMED, ci_name: 'renamed', organization_id: ORG_A, is_current: true },
      { ci_id: B_NEW, ci_name: 'new in B', organization_id: ORG_B, is_current: true },
      // A_STALE changed before the window: not selected, not loaded.
    ],
  });
});
