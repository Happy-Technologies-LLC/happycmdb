// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-907: the `change-detection` ETL job reads from real Neo4j the CIs
 * updated after its watermark, ten minutes before the run, and counts each
 * one as a detected change; CIs updated before the watermark are not counted.
 *
 * Infrastructure: the shared global integration Neo4j and PostgreSQL (env vars
 * exported by the global setup), reached through the `@cmdb/database`
 * singletons that the processor itself uses.
 */

import type { Job } from 'bullmq';
import { getQueueManager } from '@cmdb/common';
import type { ETLJobData } from '@cmdb/common';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { etlJobProcessor } from '../../src/processors/etl-processor';
import { assertIsolatedIntegrationTarget } from '../../../../tests/setup/isolated-integration-target';

// HAP-975: fail at module load, before any hook can reach a database (or wipe its CIs).
assertIsolatedIntegrationTarget();

const BEFORE_WATERMARK = [
  { id: 'hap907-ci-20m', minutesAgo: 20 },
  { id: 'hap907-ci-12m', minutesAgo: 12 },
];
const AFTER_WATERMARK = [
  { id: 'hap907-ci-8m', minutesAgo: 8 },
  { id: 'hap907-ci-6m', minutesAgo: 6 },
  { id: 'hap907-ci-2m', minutesAgo: 2 },
];

async function cypher(query: string, params: Record<string, unknown> = {}): Promise<string[]> {
  const session = getNeo4jClient().getSession();
  try {
    const result = await session.run(query, params);
    return result.records.map(record => record.get('id') as string);
  } finally {
    await session.close();
  }
}

beforeEach(async () => {
  // The change-detection query is global over (:CI); clear every CI so only these rows are eligible.
  await cypher('MATCH (c:CI) DETACH DELETE c');
  await cypher(
    `UNWIND $rows AS row
     CREATE (:CI {id: row.id, name: row.id, type: 'server', status: 'active',
       created_at: datetime() - duration({minutes: row.minutesAgo}),
       discovered_at: datetime() - duration({minutes: row.minutesAgo}),
       updated_at: datetime() - duration({minutes: row.minutesAgo})})`,
    { rows: [...BEFORE_WATERMARK, ...AFTER_WATERMARK] }
  );
  // Seed control: of the five CIs, exactly the three AFTER_WATERMARK CIs changed in the last ten minutes.
  expect(await cypher(
    `MATCH (c:CI) WHERE c.updated_at > datetime() - duration({minutes: 10})
     RETURN c.id AS id ORDER BY c.updated_at`
  )).toEqual(AFTER_WATERMARK.map(ci => ci.id));
});

afterAll(async () => {
  await cypher('MATCH (c:CI) DETACH DELETE c');
  await getNeo4jClient().close();
  await getPostgresClient().close();
  await getQueueManager().closeAll();
});

test('change detection counts every CI changed after the ten-minute watermark and no earlier CI', async () => {
  const run = etlJobProcessor.process({
    id: 'hap907',
    data: { _jobId: 'hap907', _type: 'change-detection', _config: {}, triggeredBy: 'hap907-test' },
    processedOn: Date.now(),
    updateProgress: async () => undefined,
  } as unknown as Job<ETLJobData>);

  // `resolves` reports a rejected run with its Neo4j error.
  await expect(run).resolves.toMatchObject({
    _status: 'completed',
    _itemsProcessed: AFTER_WATERMARK.length,
    _itemsCreated: AFTER_WATERMARK.length,
    _itemsUpdated: 0,
    _itemsFailed: 0,
  });
});
