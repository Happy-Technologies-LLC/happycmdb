// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-774 S6: the dry run writes nothing and prints counts and their sha256 only; apply refuses (zero writes) without
// the live report's sha256, on any bad flag or an attached worker, else purges every discovery queue and config key,
// nothing else, and fails unless the re-survey is empty. Fakes record any other API call and job-data read.
import { createHash } from 'crypto';
import { inspect } from 'util';

import { expect, it } from '@jest/globals';

import { getDiscoveryQueueNames } from '../../../../common/src/queues/queue-config';
import { main, openRedis, type PurgeDeps } from '../purge-legacy-discovery-queues';

const MARKER = 'SENSITIVE-S6-MARKER';
const NAMES = getDiscoveryQueueNames();
const OTHER = ['bull:etl-sync:meta', 'bull:etl-sync:repeat:x', 'cmdb:schedule-config:v1:etl:sync', 'cmdb:schedule-config:v1:discoveryx:a'];
type World = { store: Map<string, string>; workers: Record<string, number>; target: { runId: string } };
const typeOf = (key: string) => (key.includes(':job:') ? 'hash' : 'string');
type Listener = (error: Error) => void;

function world(workers: Record<string, number> = {}, afterObliterate?: (name: string, w: World) => unknown, faults: { connect?: Error; queueError?: Error; db?: number } = {}) {
  const store = new Map([...OTHER, ...['ssh', 'nmap'].map(provider => `cmdb:schedule-config:v1:discovery:${provider}`), ...NAMES.flatMap(name =>
    ['meta', 'job:1', 'job:2', 'repeat:discovery-definition-d1::::0 3 * * *', 'repeat:sched-1'].map(key => `bull:${name}:${key}`))].map(key => [key, MARKER] as const));
  const [calls, opened, state, listeners, printed]: [string[], unknown[], World, Listener[], Error[]] = [[], [], { store, workers, target: { runId: 'r1' } }, [], []];
  const emit = (to: Listener[], error: Error) => (to.length > 0 ? to.forEach(fn => fn(error)) : printed.push(error)); // unheard: BullMQ console.error's it whole
  const keysOf = (prefix: string) => [...store.keys()].filter(key => key.startsWith(prefix)).sort();
  const poison = (key: string) => ({ key, get data(): never { calls.push('job.data'); throw new Error(MARKER); }, get template(): never { return this.data; } });
  const guard = (api: Record<string, unknown>) => new Proxy(api, { get: (target, prop: string) => target[prop] ?? (calls.push(`unexpected ${prop}`), async () => [poison(prop)]) });
  const redis = guard({ // paged like SCAN: resumes after the last key returned, so deletes never skip a key
    scan: async (cursor: string, _match: string, pattern: string) => {
      const keys = keysOf('').filter(key => new RegExp(`^${pattern.replace('*', '.*')}$`).test(key) && (cursor === '0' || key > cursor));
      return [keys.length > 2 ? keys[1] : '0', keys.slice(0, 2)];
    },
    del: async (...keys: string[]) => keys.filter(key => calls.push(`del ${key.slice(0, 33)}`) && store.delete(key)).length,
    info: async () => `# Server\r\nredis_version:7.4.0\r\nrun_id:${state.target.runId}\r\n`,
    options: { db: faults.db ?? 0 },
    on: (_event: string, fn: Listener) => (listeners.push(fn), redis),
    connect: async () => (faults.connect ? (emit(listeners, faults.connect), Promise.reject(new Error('Connection is closed.'))) : undefined),
    client: async () => 'id=7 addr=127.0.0.1:50000 db=0 user=default', // the server never confirms a db other than 0
    type: async (key: string) => typeOf(key),
    quit: async () => 'OK',
  });
  const Queue = function (name: string, opts: { connection: unknown; prefix: string; skipMetasUpdate: boolean }) {
    opened.push([name, opts.prefix, opts.skipMetasUpdate, opts.connection === redis]);
    const [base, act, mine] = [`bull:${name}:`, (step: string) => calls.push(`${name} ${step}`), [] as Listener[]];
    const queue = guard({
      on: (_event: string, fn: Listener) => (mine.push(fn), queue),
      getJobCounts: async () => (faults.queueError && name === NAMES[0] ? (emit(mine, faults.queueError), Promise.reject(faults.queueError)) : { waiting: keysOf(`${base}job:`).length }),
      getJobSchedulersCount: async () => keysOf(`${base}repeat:`).length,
      getWorkersCount: async () => workers[name] ?? 0,
      getRepeatableJobs: async () => keysOf(`${base}repeat:discovery`).map(key => poison(key.slice(base.length + 7))),
      getJobSchedulers: async () => keysOf(`${base}repeat:sched`).map(key => poison(key.slice(base.length + 7))),
      removeRepeatableByKey: async (key: string) => act('removeRepeatable') && store.delete(`${base}repeat:${key}`),
      removeJobScheduler: async (id: string) => act('removeJobScheduler') && store.delete(`${base}repeat:${id}`),
      pause: async () => act('pause'),
      obliterate: async (opts: { force: boolean }) => (act(`obliterate ${opts.force}`), keysOf(base).forEach(key => store.delete(key)), afterObliterate?.(name, state)),
      close: async () => undefined,
    });
    return queue;
  };
  return { ...state, calls, opened, printed, deps: { redis, Queue } as unknown as PurgeDeps };
}

async function run(deps: PurgeDeps | undefined, argv: string[], env: NodeJS.ProcessEnv = { CMDB_PURGE_REDIS_URL: 'redis://fake' }) {
  const out: string[] = [];
  const code = await main(argv, env, { stdout: line => out.push(line), stderr: line => out.push(line) }, () => deps ?? (() => { throw new Error('opened'); })());
  expect(out.join('\n')).not.toMatch(new RegExp(`${MARKER}|discovery-definition|sched-1|v1:|redis://`));
  return { code, out, json: JSON.parse(out[0]!.startsWith('{') ? out[0]! : '{}') as Record<string, unknown> };
}

it('the default dry run writes nothing, covers every discovery queue under the bull prefix, prints counts only', async () => {
  const w = world();
  const before = new Map(w.store);
  const { code, json: { mode, sha256, ...report } } = await run(w.deps, []);
  expect([code, w.store, w.calls, w.opened]).toEqual([0, before, [], NAMES.map(name => [name, 'bull', true, true])]);
  expect([mode, sha256]).toEqual(['dry-run', createHash('sha256').update(`${JSON.stringify(report)}\n${[...w.store.keys()].filter(key => /^(bull:discovery-[a-z-]+:|cmdb:schedule-config:v1:discovery:)/.test(key))
    .sort().map(key => `${key}\t${typeOf(key)}`).join('\n')}`).digest('hex')]); // the printed report in printed order, then every discovery key's name and TYPE, sorted
  expect(report).toEqual({ prefix: 'bull', target: { runId: 'r1', db: 0 }, scheduleConfigKeys: 2,
    queues: Object.fromEntries(NAMES.map(name => [name, { jobs: 2, repeatables: 2, keys: 5, workers: 0 }])) });
});

it.each<[string, Record<string, number> | undefined, (sha: string) => string[], number, string, ((w: World) => unknown) | undefined]>([
  ['a worker on the last queue', { [NAMES[NAMES.length - 1]!]: 1 }, sha => ['--apply', '--operator', 'nick', '--sha256', sha], 2, 'refused', undefined],
  ['no --operator', undefined, sha => ['--apply', '--sha256', sha], 1, 'usage', undefined],
  ['a mistyped --Apply (no silent dry run)', {}, sha => ['--Apply', '--operator', 'nick', '--sha256', sha], 1, 'usage', undefined],
  ['an unknown flag (--prefix bullmq)', {}, sha => ['--apply', '--operator', 'nick', '--sha256', sha, '--prefix', 'bullmq'], 1, 'usage', undefined],
  ['an --operator value that is a flag', {}, sha => ['--apply', '--sha256', sha, '--operator', '--apply'], 1, 'usage', undefined],
  ['no --sha256', {}, () => ['--apply', '--operator', 'nick'], 1, 'usage', undefined],
  ['an empty --operator', undefined, sha => ['--apply', '--operator', ' ', '--sha256', sha], 1, 'usage', undefined],
  ['the sha256 of another report', {}, () => ['--apply', '--operator', 'nick', '--sha256', 'f'.repeat(64)], 2, 'refused', undefined],
  ['a stale sha256 (one discovery key added)', {}, sha => ['--apply', '--operator', 'nick', '--sha256', sha], 2, 'refused', w => w.store.set(`bull:${NAMES[0]}:job:3`, MARKER)],
  ['a stale sha256 (another Redis run_id)', {}, sha => ['--apply', '--operator', 'nick', '--sha256', sha], 2, 'refused', w => (w.target.runId = 'r2')],
  ['a stale sha256 (one key renamed, counts unchanged)', {}, sha => ['--apply', '--operator', 'nick', '--sha256', sha], 2, 'refused', w => w.store.delete('cmdb:schedule-config:v1:discovery:ssh') && w.store.set('cmdb:schedule-config:v1:discovery:zz', MARKER)],
])('apply with %s exits non-zero, writing nothing', async (_label, workers, args, exit, message, change) => {
  const w = workers && world(workers);
  const sha = w === undefined ? 'a'.repeat(64) : ((await run(w.deps, [])).json['sha256'] as string);
  w && change?.(w);
  const before = new Map(w?.store);
  const { code, out } = await run(w?.deps, args(sha));
  expect([code, out, w?.store ?? new Map(), w?.calls ?? []]).toEqual([exit, [expect.stringContaining(message)], before, []]);
});

it('apply without CMDB_PURGE_REDIS_URL exits 1 before Redis opens', async () => {
  expect(await run(undefined, ['--apply', '--operator', 'nick', '--sha256', 'a'.repeat(64)], {})).toMatchObject({ code: 1, out: [expect.stringContaining('usage')] });
});

const authError = (user: string) => Object.assign(new Error('WRONGPASS invalid username-password pair'), { name: 'ReplyError', command: { name: 'auth', args: [user, 'S6SENTINEL-pw'] } });
it.each<[string, Parameters<typeof world>[2], string]>([
  ['a wrong password on connect', { connect: authError('realuser') }, 'failed (Error)'],
  ['an unknown user on connect', { connect: authError('nouser') }, 'failed (Error)'],
  ['Redis unreachable', { connect: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379 S6SENTINEL-pw'), { code: 'ECONNREFUSED' }) }, 'failed (Error)'],
  ['a wrong password on a queue connection', { queueError: authError('realuser') }, 'failed (ReplyError)'],
  ['an unknown user on a queue connection', { queueError: authError('nouser') }, 'failed (ReplyError)'],
  ['db 99 requested but not confirmed by the server', { db: 99 }, 'refused: the server did not confirm the requested db'],
])('startup with %s exits 1 with fixed text, writing nothing and printing no credential or address', async (_label, faults, message) => {
  const w = world({}, undefined, faults);
  const { code, out } = await run(w.deps, ['--apply', '--operator', 'nick', '--sha256', 'a'.repeat(64)]);
  expect([code, out.at(-1), w.store, w.calls]).toEqual([1, `purge-legacy-discovery-queues: ${message}`, world().store, []]);
  expect(inspect([out, w.printed], { depth: 9 })).not.toMatch(/S6SENTINEL|127\.0\.0\.1/);
});

it('the real connection is bounded: connects only when asked, 5 s timeout (not the 10 s default), no reconnect, no offline queue', () => {
  const { redis } = openRedis('redis://user:S6SENTINEL-pw@127.0.0.1:1/0');
  expect([redis.status, redis.options.connectTimeout, redis.options.retryStrategy?.(1), redis.options.enableOfflineQueue]).toEqual(['wait', 5_000, null, false]);
});

it.each<[string, ((name: string, w: World) => unknown) | undefined, string | undefined, string[]]>([
  ['all succeeds', undefined, undefined, []],
  ['obliterate fails on one queue', name => (name === NAMES[2] ? Promise.reject(new Error(MARKER)) : undefined), NAMES[2], []],
  ['obliterate leaves a key behind', (name, w) => name === NAMES[2] && w.store.set(`bull:${name}:orphan`, MARKER), undefined, [`bull:${NAMES[2]}:orphan`]],
  ['a worker attaches mid-run', (name, w) => (w.workers[name] = 1), undefined, []],
])('apply where %s purges every discovery queue and key, nothing else, and exits 0 only on an empty re-survey', async (_label, hook, failed, left) => {
  const w = world({}, hook);
  const { code, json } = await run(w.deps, ['--apply', '--operator', 'nick', '--sha256', (await run(w.deps, [])).json['sha256'] as string]);
  expect([code, json['ok'], json['deletedScheduleConfigKeys']]).toEqual([hook ? 1 : 0, !hook, 2]);
  expect(json['purged']).toEqual(Object.fromEntries(NAMES.map(name => [name, { removedRepeatables: 1, removedSchedulers: 1, ...(name === failed && { failed: 'obliterate' }) }])));
  expect(w.calls).toEqual([...NAMES.flatMap(name => ['pause', 'removeRepeatable', 'removeJobScheduler', 'obliterate true'].map(step => `${name} ${step}`)),
    ...Array(2).fill('del cmdb:schedule-config:v1:discovery')]);
  expect([...w.store.keys()].sort()).toEqual([...OTHER, ...left].sort());
});
