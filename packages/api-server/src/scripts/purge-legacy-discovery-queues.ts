// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-774 S6 (design §4b, R1): purges the legacy, secret-bearing discovery queues and schedule-config keys from
 * Redis, operator-run after every worker and scheduler has stopped. Default: a read-only dry run printing a counts
 * report (plus the server run_id and confirmed db, never the URL) and a sha256 that also covers each discovery key's
 * name and TYPE (never printed). `--apply --operator <name> --sha256 <dry-run sha256>` re-runs it live and refuses
 * (exit 2, nothing written) on a mismatch or an attached worker; otherwise it pauses each queue, removes its
 * repeatables and job schedulers, obliterates it, deletes the schedule-config keys and verifies every count is 0
 * (exit 1 otherwise). Bad flags, an unconfirmed db or a failed connect (once, bounded) exit 1. Never reads job data;
 * SCAN, never KEYS; prints counts and error names only. Connects only to CMDB_PURGE_REDIS_URL.
 */

import { createHash } from 'crypto';

import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

// Direct module import (not the @cmdb/common barrel), as the other operator scripts do.
import { getDiscoveryQueueNames } from '../../../common/src/queues/queue-config';

/** Neither queue manager sets a prefix, so BullMQ's default is the configured one. */
const PREFIX = 'bull';
const SCHEDULE_CONFIG_KEYS = 'cmdb:schedule-config:v1:discovery:*';

export interface PurgeDeps { redis: Redis; Queue: typeof Queue }
/** Bounded startup: connect explicitly, once, within 5 s; no reconnect and no offline queue, so nothing hangs. */
export const openRedis = (url: string): PurgeDeps => ({ redis: new Redis(url, { lazyConnect: true, connectTimeout: 5_000, retryStrategy: () => null, maxRetriesPerRequest: 1, enableOfflineQueue: false }), Queue });
interface QueuePurge { removedRepeatables: number; removedSchedulers: number; failed?: string }
interface Survey { prefix: string; target: { runId: string; db: number }; queues: Record<string, { jobs: number; repeatables: number; keys: number; workers: number }>; scheduleConfigKeys: number }

/** Every distinct key matching `pattern`, sorted, one SCAN page at a time (each page optionally handed over). */
async function scanKeys(redis: Redis, pattern: string, onKeys?: (keys: string[]) => Promise<unknown>): Promise<string[]> {
  const seen = new Set<string>(); // SCAN may repeat a key; the report must not depend on that
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
    await (keys.length > 0 ? onKeys?.(keys) : undefined);
    keys.forEach(key => seen.add(key));
    cursor = next;
  } while (cursor !== '0');
  return [...seen].sort();
}

async function survey(redis: Redis, queues: Map<string, Queue>, db: number, inventory: string[] = []): Promise<Survey> {
  const [counts, collect]: [Survey['queues'], (keys: string[]) => Promise<number>] = [{}, keys => Promise.resolve(inventory.push(...keys))];
  for (const [name, queue] of queues) {
    counts[name] = { jobs: Object.values(await queue.getJobCounts()).reduce((sum, n) => sum + n, 0), repeatables: await queue.getJobSchedulersCount(),
      keys: (await scanKeys(redis, `${PREFIX}:${name}:*`, collect)).length, workers: await queue.getWorkersCount() };
  }
  const target = { runId: /^run_id:(\w+)/m.exec(await redis.info('server'))?.[1] ?? 'unknown', db };
  return { prefix: PREFIX, target, queues: counts, scheduleConfigKeys: (await scanKeys(redis, SCHEDULE_CONFIG_KEYS, collect)).length };
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
  open = openRedis
): Promise<number> {
  let deps: PurgeDeps | undefined;
  const queues = new Map<string, Queue>();
  // Fixed text only: never a key, a value or an error message.
  const fail = (message: string, code: 1 | 2): number => (io.stderr(`purge-legacy-discovery-queues: ${message}`), code);
  try {
    const flags = new Map<string, string>(); // an unknown or valueless flag fails, so a typo never drops the gate
    for (let i = 0; i < argv.length; i++) {
      flags.set(argv[i]!, argv[i] === '--apply' ? '' : argv[++i] ?? '--');
    }
    const [apply, operator, reviewed, url] = [flags.has('--apply'), flags.get('--operator') ?? '', flags.get('--sha256') ?? '', env['CMDB_PURGE_REDIS_URL'] ?? ''];
    const known = [...flags].every(([flag, value]) => flag === '--apply' || (['--operator', '--sha256'].includes(flag) && !value.startsWith('--')));
    if (!known || url === '' || (apply && (operator.trim() === '' || !/^[0-9a-f]{64}$/.test(reviewed)))) {
      return fail('usage: CMDB_PURGE_REDIS_URL=<url> purge-legacy-discovery-queues [--apply --operator <name> --sha256 <dry-run sha256>]', 1);
    }
    const { redis, Queue: QueueClass } = (deps = open(url));
    // Before any command: an unhandled BullMQ/ioredis error event is console.error'ed with its AUTH arguments.
    const onError = (error: unknown): void => io.stderr(`purge-legacy-discovery-queues: redis error (${error instanceof Error ? error.name : 'unknown'})`);
    await redis.on('error', onError).connect();
    // ioredis only logs a failed SELECT and stays on db 0: trust only the db the server reports.
    const db = Number(/\bdb=(\d+)/.exec(String(await redis.client('INFO')))?.[1] ?? -1);
    if (db !== (redis.options.db ?? 0)) {
      return fail('refused: the server did not confirm the requested db', 1);
    }
    for (const name of getDiscoveryQueueNames()) {
      // skipMetasUpdate: constructing a queue must not write its meta hash.
      queues.set(name, new QueueClass(name, { connection: redis, prefix: PREFIX, skipMetasUpdate: true }).on('error', onError));
    }
    const inventory: string[] = [];
    const before = await survey(redis, queues, db, inventory);
    // Canonical input: the printed report (without `mode`/`sha256`), then each sorted discovery key's name and TYPE.
    const typed = await Promise.all([...new Set(inventory)].sort().map(async key => `${key}\t${await redis.type(key)}`));
    const sha256 = createHash('sha256').update(`${JSON.stringify(before)}\n${typed.join('\n')}`).digest('hex');
    if (!apply) {
      io.stdout(JSON.stringify({ mode: 'dry-run', ...before, sha256 }));
      return 0;
    }
    if (Object.values(before.queues).some(counts => counts.workers !== 0)) {
      return fail('refused: a worker is attached to a discovery queue', 2);
    }
    if (sha256 !== reviewed) {
      return fail('refused: the live report differs from the reviewed dry run (--sha256)', 2);
    }
    const purged: Record<string, QueuePurge> = {};
    for (const [name, queue] of queues) {
      purged[name] = await purgeQueue(queue);
    }
    const deleted = await scanKeys(redis, SCHEDULE_CONFIG_KEYS, keys => redis.del(...keys)).then(keys => keys.length, () => null);
    const after = await survey(redis, queues, db);
    const ok = deleted !== null && Object.values(purged).every(result => result.failed === undefined) && after.scheduleConfigKeys === 0
      && Object.values(after.queues).every(counts => counts.jobs + counts.repeatables + counts.keys + counts.workers === 0);
    io.stdout(JSON.stringify({ mode: 'apply', operator, sha256, before, purged, deletedScheduleConfigKeys: deleted, after, ok }));
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
