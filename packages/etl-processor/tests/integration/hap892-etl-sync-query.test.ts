// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-892: the incremental `sync` ETL job reads the CIs changed in the last
 * five minutes from real Neo4j, oldest change first, at most `batchSize` of
 * them, and hands each one to the data-mart load step.
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

const STALE = 'hap892-ci-6m';
const OLDEST_RECENT = 'hap892-ci-4m';
const MIDDLE_RECENT = 'hap892-ci-3m';
const NEWEST_RECENT = 'hap892-ci-2m';

/** Runs a Cypher statement on the shared integration Neo4j and returns its `id` column. */
async function cypher(query: string, params: Record<string, unknown> = {}): Promise<string[]> {
  const session = getNeo4jClient().getSession();
  try {
    const result = await session.run(query, params);
    return result.records.map(record => record.get('id') as string);
  } finally {
    await session.close();
  }
}

function syncJob(config: ETLJobData['_config']): Job<ETLJobData> {
  return {
    id: 'hap892',
    data: { _jobId: 'hap892', _type: 'sync', _config: config, triggeredBy: 'hap892-test' },
    processedOn: Date.now(),
    updateProgress: async () => undefined,
  } as unknown as Job<ETLJobData>;
}

/** Runs the sync job and returns its result and the CI ids it handed to the load step, in order. */
async function runSync(config: ETLJobData['_config']) {
  const load = jest.spyOn(getPostgresClient(), 'query');
  const result = await etlJobProcessor.process(syncJob(config));
  return { result, loaded: load.mock.calls.map(([, params]) => params?.[1]) };
}

beforeEach(async () => {
  // The sync query is global over (:CI); clear every CI so only these rows are eligible.
  await cypher('MATCH (c:CI) DETACH DELETE c');
  // Three CIs changed inside the five-minute window and one changed six minutes ago.
  await cypher(
    `UNWIND $rows AS row
     CREATE (:CI {id: row.id, name: row.id, type: 'server', status: 'active',
       updated_at: datetime() - duration({minutes: row.minutesAgo})})`,
    { rows: [
      { id: STALE, minutesAgo: 6 },
      { id: OLDEST_RECENT, minutesAgo: 4 },
      { id: MIDDLE_RECENT, minutesAgo: 3 },
      { id: NEWEST_RECENT, minutesAgo: 2 },
    ] }
  );
  // Seed control: exactly the three recent CIs are inside the window, oldest first.
  expect(await cypher(
    `MATCH (c:CI) WHERE c.updated_at > datetime() - duration({minutes: 5})
     RETURN c.id AS id ORDER BY c.updated_at`
  )).toEqual([OLDEST_RECENT, MIDDLE_RECENT, NEWEST_RECENT]);
});

afterAll(async () => {
  await cypher('MATCH (c:CI) DETACH DELETE c');
  await getNeo4jClient().close();
  await getPostgresClient().close();
  await getQueueManager().closeAll();
});

test('batchSize 1 syncs only the oldest CI changed in the last five minutes', async () => {
  const { result, loaded } = await runSync({ batchSize: 1 });

  expect(result._itemsProcessed).toBe(1);
  expect(loaded).toEqual([OLDEST_RECENT]);
});

test('the default batch syncs every CI changed in the last five minutes, oldest first, and no older CI', async () => {
  const { result, loaded } = await runSync({});

  expect(result._itemsProcessed).toBe(3);
  expect(loaded).toEqual([OLDEST_RECENT, MIDDLE_RECENT, NEWEST_RECENT]);
});
