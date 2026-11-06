// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1444 (AAI S2): the C4 release sync queue. The fan-out job (data `{}`) enqueues one tenant job per organization
 * holding a C4 principal; a tenant job's data is exactly `{organizationId}` and its result is counts only. The token
 * is resolved inside syncC4Releases and never reaches job data, a result or a log line.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { CodedJobError, codedProcessor, jobErrorCode, logger } from '@cmdb/common';
import { getNeo4jClient, getPostgresClient, getRedisClient, getUnifiedCredentialService } from '@cmdb/database';
import { c4Origin } from '../ai-sync/c4-client';
import { AI_SYNC_C4_QUEUE, C4_FANOUT_JOB, C4_TENANT_JOB, enqueueC4ReleaseSyncs, syncC4Releases } from '../ai-sync/c4-release-sync';
import { AISyncScheduler } from '../schedulers/ai-sync-scheduler';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESULT_SHAPES = [
  { enqueued: 'count' },
  { success: 'flag', created: 'count', updated: 'count', unchanged: 'count', retired: 'count', refused: 'count' },
] as const;

/**
 * Starts the scheduler and worker for the C4 named by `configuredUrl` (server configuration, never tenant data). Returns
 * null, starting nothing, when it is unset or not an http(s) URL without userinfo.
 */
export async function startAISyncC4(configuredUrl: string | undefined): Promise<{ close(): Promise<void> } | null> {
  const baseUrl = c4Origin(configuredUrl);
  if (!baseUrl) {
    logger.info('C4 release sync disabled (HAPPYLAB_C4_URL is not an http(s) URL)');
    return null;
  }
  const connection = getRedisClient().getConnection().duplicate({ maxRetriesPerRequest: null });
  const queue = new Queue(AI_SYNC_C4_QUEUE, { connection });
  const worker = new Worker(AI_SYNC_C4_QUEUE, codedProcessor(AI_SYNC_C4_QUEUE, RESULT_SHAPES, async (job: Job) => {
    const data = job.data as Record<string, unknown> | null;
    const keys = data && typeof data === 'object' ? Object.keys(data) : null;
    if (job.name === C4_FANOUT_JOB && keys?.length === 0) {
      return { enqueued: await enqueueC4ReleaseSyncs(queue, getUnifiedCredentialService(getPostgresClient().pool)) };
    }
    const organizationId = data?.['organizationId'];
    if (job.name !== C4_TENANT_JOB || keys?.length !== 1 || typeof organizationId !== 'string' || !UUID.test(organizationId)) {
      throw new CodedJobError('ERR_VALIDATION');
    }
    return syncC4Releases(organizationId, { neo4j: getNeo4jClient(), pool: getPostgresClient().pool, baseUrl });
  }), { connection, concurrency: 2 });
  worker.on('failed', (_job, error) => logger.error('[AISyncWorker] Job failed', { code: jobErrorCode(error) }));
  worker.on('error', error => logger.error('[AISyncWorker] Worker error', { code: jobErrorCode(error) }));
  await new AISyncScheduler(queue).start();
  logger.info('[AISyncWorker] C4 release sync started');
  return {
    async close() {
      await worker.close();
      await queue.close();
      await connection.quit();
    },
  };
}
