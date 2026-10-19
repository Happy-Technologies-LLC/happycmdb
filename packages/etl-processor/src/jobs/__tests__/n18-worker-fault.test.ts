// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0
import type { Job } from 'bullmq';
import type { Neo4jClient, PostgresClient } from '@cmdb/database';
import { codedProcessor, logger } from '@cmdb/common';
import { processNeo4jToPostgresJob } from '../neo4j-to-postgres.job';
import { processFullRefreshJob } from '../full-refresh.job';
import { installETLReadFault } from '../../../tests/scratch/n18-etl-read-fault';
import { installWorkerStartFault } from '../../../tests/scratch/n18-worker-start-fault';

it('forces the real ETL processor read to fail without depending on graph contents', async () => {
  const close = jest.fn(async () => undefined);
  class GraphSession {
    async run() { return { records: [] }; }
    async close() { return close(); }
  }
  class GraphClient {
    getSession() { return new GraphSession(); }
  }
  const graph = new GraphClient();
  const postgres = { query: jest.fn() };
  // These stand-ins implement only the read path exercised before the first write.
  const graphClient = graph as unknown as Neo4jClient;
  const postgresClient = postgres as unknown as PostgresClient;
  const processor = codedProcessor('etl-sync', {
    cisProcessed: 'count', relationshipsProcessed: 'count', recordsInserted: 'count',
    recordsUpdated: 'count', errors: 'count', durationMs: 'count', completedAt: 'timestamp',
  }, async (job: Job) => processNeo4jToPostgresJob(job, graphClient, postgresClient));
  const normal = { id: 'normal', queueName: 'etl-sync', data: { incrementalSince: '2099-01-01T00:00:00Z' } } as Job;
  const targeted = { id: 'n18-fault', queueName: 'etl-sync', data: { incrementalSince: 'n18-read-fault' } } as Job;
  const fault = installETLReadFault(graphClient, targeted);
  try {
    await expect(processor(normal)).resolves.toMatchObject({ cisProcessed: 0 });
    await expect(processor(targeted)).rejects.toMatchObject({ message: 'ERR_INTERNAL' });
    expect(fault.injected()).toBe(true);
    expect(close).toHaveBeenCalledTimes(2);
    expect(postgres.query).not.toHaveBeenCalled();
  } finally {
    fault.restore();
  }
});

it('fails a registered full-refresh graph read before any write even with an empty graph', async () => {
  class GraphSession {
    async run() { return { records: [] }; }
    async close() { return undefined; }
  }
  class GraphClient {
    getSession() { return new GraphSession(); }
  }
  const graphClient = new GraphClient() as unknown as Neo4jClient;
  const postgres = { query: jest.fn() };
  const postgresClient = postgres as unknown as PostgresClient;
  const job = { id: 'n18-refresh-fault', queueName: 'etl-full-refresh',
    data: { truncateTables: false, rebuildIndexes: false } } as Job;
  const fault = installETLReadFault(graphClient, job);
  try {
    await expect(processFullRefreshJob(job, graphClient, postgresClient))
      .rejects.toThrow('n18-injected-storage-fault');
    expect(fault.injected()).toBe(true);
    expect(postgres.query).not.toHaveBeenCalled();
  } finally {
    fault.restore();
  }
});

it('classifies a scoped v3 worker-entry failure without affecting a different job', async () => {
  const target = { id: 'n18-fault', queueName: 'etl-cis' } as Job;
  const other = { id: 'normal', queueName: 'etl-cis' } as Job;
  const processor = codedProcessor('etl-cis', { processed: 'count' }, async (job: Job) => {
    logger.info('[CISyncWorker] Processing CI sync job', { jobId: job.id });
    return { processed: 1 };
  });
  const fault = installWorkerStartFault(target);
  try {
    await expect(processor(other)).resolves.toEqual({ processed: 1 });
    await expect(processor(target)).rejects.toMatchObject({ message: 'ERR_INTERNAL' });
    expect(fault.injected()).toBe(true);
  } finally {
    fault.restore();
  }
});
