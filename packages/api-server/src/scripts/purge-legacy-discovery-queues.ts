// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-774 S6 (design §4b, R1): purges the legacy, secret-bearing discovery queues and schedule-config keys
 * from Redis, operator-run after every worker and scheduler has stopped. Default: a read-only dry run.
 * `--apply --operator <name>` refuses (exit 2, nothing written) while a worker is attached; otherwise it
 * pauses each queue, removes its repeatables and job schedulers, obliterates it, deletes the schedule-config
 * keys and verifies every count is 0 (exit 1 on any failed step). Never reads job data; SCAN, never KEYS;
 * prints counts only. Connects only to CMDB_PURGE_REDIS_URL.
 */

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

// Direct module import (not the @cmdb/common barrel), as the other operator scripts do.
import { getDiscoveryQueueNames } from '../../../common/src/queues/queue-config';

/** Neither queue manager sets a prefix, so BullMQ's default is the configured one. */
const PREFIX = 'bull';
const SCHEDULE_CONFIG_KEYS = 'cmdb:schedule-config:v1:discovery:*';

export interface PurgeDeps { redis: Redis; Queue: typeof Queue }
interface QueuePurge { removedRepeatables: number; removedSchedulers: number; failed?: string }
interface Survey { prefix: string; queues: Record<string, { jobs: number; repeatables: number; keys: number; workers: number }>; scheduleConfigKeys: number }

/** Counts (and optionally hands over) every key matching `pattern`, one SCAN page at a time. */
async function scanCount(redis: Redis, pattern: string, onKeys?: (keys: string[]) => Promise<unknown>): Promise<number> {
  let [cursor, total] = ['0', 0];
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    await (keys.length > 0 ? onKeys?.(keys) : undefined);
    [cursor, total] = [next, total + keys.length];
  } while (cursor !== '0');
  return total;
}

async function survey(redis: Redis, queues: Map<string, Queue>): Promise<Survey> {
  const counts: Survey['queues'] = {};
  for (const [name, queue] of queues) {
    const jobs = Object.values(await queue.getJobCounts()).reduce((sum, n) => sum + n, 0);
    const [repeatables, keys, workers] = [await queue.getJobSchedulersCount(), await scanCount(redis, `${PREFIX}:${name}:*`), await queue.getWorkersCount()];
    counts[name] = { jobs, repeatables, keys, workers };
  }
  return { prefix: PREFIX, queues: counts, scheduleConfigKeys: await scanCount(redis, SCHEDULE_CONFIG_KEYS) };
}

/** Names the first failed step, never its error. */
async function purgeQueue(queue: Queue): Promise<QueuePurge> {
  const result: QueuePurge = { removedRepeatables: 0, removedSchedulers: 0 };
  let step = 'pause';
  try {
    await queue.pause();
    step = 'repeatables';
    result.removedRepeatables = (await Promise.all((await queue.getRepeatableJobs()).map(({ key }) => queue.removeRepeatableByKey(key)))).length;
    step = 'schedulers';
    result.removedSchedulers = (await Promise.all((await queue.getJobSchedulers()).map(({ key }) => queue.removeJobScheduler(key)))).length;
    step = 'obliterate';
    await queue.obliterate({ force: true });
  } catch {
    result.failed = step;
  }
  return result;
}

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: { stdout: (line: string) => void; stderr: (line: string) => void },
  open = (url: string): PurgeDeps => ({ redis: new Redis(url, { maxRetriesPerRequest: 1 }), Queue })
): Promise<number> {
  let deps: PurgeDeps | undefined;
  const queues = new Map<string, Queue>();
  // Fixed text only: never a key, a value or an error message.
  const fail = (message: string, code: 1 | 2): number => (io.stderr(`purge-legacy-discovery-queues: ${message}`), code);
  try {
    const [apply, url, operator] = [argv.includes('--apply'), env['CMDB_PURGE_REDIS_URL'] ?? '', argv.includes('--operator') ? argv[argv.indexOf('--operator') + 1] ?? '' : ''];
    if (url === '' || (apply && (operator.trim() === '' || operator.startsWith('--')))) {
      return fail('usage: CMDB_PURGE_REDIS_URL=<url> purge-legacy-discovery-queues [--apply --operator <name>]', 1);
    }
    const { redis, Queue: QueueClass } = (deps = open(url));
    for (const name of getDiscoveryQueueNames()) {
      // skipMetasUpdate: constructing a queue must not write its meta hash.
      queues.set(name, new QueueClass(name, { connection: redis, prefix: PREFIX, skipMetasUpdate: true }));
    }
    const before = await survey(redis, queues);
    if (!apply) {
      io.stdout(JSON.stringify({ mode: 'dry-run', ...before }));
      return 0;
    }
    if (Object.values(before.queues).some(counts => counts.workers !== 0)) {
      return fail('refused: a worker is attached to a discovery queue', 2);
    }
    const purged: Record<string, QueuePurge> = {};
    for (const [name, queue] of queues) {
      purged[name] = await purgeQueue(queue);
    }
    const deleted = await scanCount(redis, SCHEDULE_CONFIG_KEYS, keys => redis.del(...keys)).catch(() => null);
    const after = await survey(redis, queues);
    const ok = deleted !== null && Object.values(purged).every(result => result.failed === undefined) && after.scheduleConfigKeys === 0
      && Object.values(after.queues).every(counts => counts.jobs + counts.repeatables + counts.keys + counts.workers === 0);
    io.stdout(JSON.stringify({ mode: 'apply', operator, before, purged, deletedScheduleConfigKeys: deleted, after, ok }));
    return ok ? 0 : 1;
  } catch (error) {
    return fail(`failed (${error instanceof Error ? error.name : 'unknown'})`, 1);
  } finally {
    await Promise.all([...queues.values()].map(queue => queue.close().catch(() => undefined)));
    await deps?.redis.quit().catch(() => undefined);
  }
}

if (require.main === module) {
  const writeLine = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);
  const io = { stdout: (line: string) => writeLine(`${line}\n`), stderr: (line: string) => process.stderr.write(`${line}\n`) };
  void main(process.argv.slice(2), process.env, io).then(code => process.exit(code));
}
