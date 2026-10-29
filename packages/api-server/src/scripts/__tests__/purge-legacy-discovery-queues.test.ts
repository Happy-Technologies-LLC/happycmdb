// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

// HAP-774 S6: the dry run writes nothing, prints counts only; apply refuses while a worker is attached, then empties
// every discovery queue and schedule-config key, nothing else. Fakes record any other API call and job-data read.
import { expect, it } from '@jest/globals';

import { getDiscoveryQueueNames } from '../../../../common/src/queues/queue-config';
import { main, type PurgeDeps } from '../purge-legacy-discovery-queues';

const MARKER = 'SENSITIVE-S6-MARKER';
const NAMES = getDiscoveryQueueNames();
const OTHER = ['bull:etl-sync:meta', 'bull:etl-sync:repeat:x', 'cmdb:schedule-config:v1:etl:sync', 'cmdb:schedule-config:v1:discoveryx:a'];

function world(workers: Record<string, number> = {}, failOn?: string) {
  const store = new Map([...OTHER, ...['ssh', 'nmap'].map(provider => `cmdb:schedule-config:v1:discovery:${provider}`), ...NAMES.flatMap(name =>
    ['meta', 'job:1', 'job:2', 'repeat:discovery-definition-d1::::0 3 * * *', 'repeat:sched-1'].map(key => `bull:${name}:${key}`))].map(key => [key, MARKER] as const));
  const [calls, opened]: [string[], unknown[]] = [[], []];
  const keysOf = (prefix: string) => [...store.keys()].filter(key => key.startsWith(prefix)).sort();
  const poison = (key: string) => ({ key, get data(): never { calls.push('job.data'); throw new Error(MARKER); }, get template(): never { return this.data; } });
  const guard = (api: Record<string, unknown>) => new Proxy(api, { get: (target, prop: string) => target[prop] ?? (calls.push(`unexpected ${prop}`), async () => [poison(prop)]) });
  const redis = guard({ // paged like SCAN: resumes after the last key returned, so deletes never skip a key
    scan: async (cursor: string, _match: string, pattern: string) => {
      const keys = keysOf('').filter(key => new RegExp(`^${pattern.replace('*', '.*')}$`).test(key) && (cursor === '0' || key > cursor));
      return [keys.length > 2 ? keys[1] : '0', keys.slice(0, 2)];
    },
    del: async (...keys: string[]) => keys.filter(key => calls.push(`del ${key.slice(0, 33)}`) && store.delete(key)).length,
    quit: async () => 'OK',
  });
  const Queue = function (name: string, opts: { connection: unknown; prefix: string; skipMetasUpdate: boolean }) {
    opened.push([name, opts.prefix, opts.skipMetasUpdate, opts.connection === redis]);
    const [base, act] = [`bull:${name}:`, (step: string) => calls.push(`${name} ${step}`)];
    return guard({
      getJobCounts: async () => ({ waiting: keysOf(`${base}job:`).length }),
      getJobSchedulersCount: async () => keysOf(`${base}repeat:`).length,
      getWorkersCount: async () => workers[name] ?? 0,
      getRepeatableJobs: async () => keysOf(`${base}repeat:discovery`).map(key => poison(key.slice(base.length + 7))),
      getJobSchedulers: async () => keysOf(`${base}repeat:sched`).map(key => poison(key.slice(base.length + 7))),
      removeRepeatableByKey: async (key: string) => act('removeRepeatable') && store.delete(`${base}repeat:${key}`),
      removeJobScheduler: async (id: string) => act('removeJobScheduler') && store.delete(`${base}repeat:${id}`),
      pause: async () => act('pause'),
      obliterate: async (opts: { force: boolean }) => act(`obliterate ${opts.force}`) && name !== failOn ? keysOf(base).forEach(key => store.delete(key)) : Promise.reject(new Error(MARKER)),
      close: async () => undefined,
    });
  };
  return { store, calls, opened, deps: { redis, Queue } as unknown as PurgeDeps };
}

async function run(deps: PurgeDeps | undefined, ...argv: string[]) {
  const out: string[] = [];
  const code = await main(argv, { CMDB_PURGE_REDIS_URL: 'redis://fake' }, { stdout: line => out.push(line), stderr: line => out.push(line) }, () => deps ?? (() => { throw new Error('opened'); })());
  expect(out.join('\n')).not.toMatch(new RegExp(`${MARKER}|discovery-definition|sched-1|v1:`));
  return { code, out, json: JSON.parse(out[0]!.startsWith('{') ? out[0]! : '{}') as Record<string, unknown> };
}

it('the default dry run writes nothing, covers every discovery queue under the bull prefix, prints counts only', async () => {
  const w = world();
  const before = new Map(w.store);
  const { code, json } = await run(w.deps);
  expect([code, w.store, w.calls, w.opened]).toEqual([0, before, [], NAMES.map(name => [name, 'bull', true, true])]);
  expect(json).toEqual({ mode: 'dry-run', prefix: 'bull', scheduleConfigKeys: 2, queues: Object.fromEntries(NAMES.map(name => [name, { jobs: 2, repeatables: 2, keys: 5, workers: 0 }])) });
});

it.each<[string, Record<string, number> | undefined, string[], number, string]>([
  ['a worker on the last queue', { [NAMES[NAMES.length - 1]!]: 1 }, ['--apply', '--operator', 'nick'], 2, 'refused'],
  ['no --operator', undefined, ['--apply'], 1, 'usage'],
  ['an empty --operator', undefined, ['--apply', '--operator', ' '], 1, 'usage'],
])('apply with %s exits non-zero, writing nothing', async (_label, workers, argv, exit, message) => {
  const w = workers && world(workers);
  const before = new Map(w?.store);
  const { code, out } = await run(w?.deps, ...argv);
  expect([code, out, w?.store ?? new Map(), w?.calls ?? []]).toEqual([exit, [expect.stringContaining(message)], before, []]);
});

it.each([undefined, NAMES[2]])('apply (obliterate failing on %s) purges every discovery queue and key, nothing else', async (failOn) => {
  const w = world({}, failOn);
  const { code, json } = await run(w.deps, '--apply', '--operator', 'nick');
  expect([code, json['ok'], json['deletedScheduleConfigKeys']]).toEqual([failOn === undefined ? 0 : 1, failOn === undefined, 2]);
  expect(json['purged']).toEqual(Object.fromEntries(NAMES.map(name => [name, { removedRepeatables: 1, removedSchedulers: 1, ...(name === failOn && { failed: 'obliterate' }) }])));
  expect(w.calls).toEqual([...NAMES.flatMap(name => ['pause', 'removeRepeatable', 'removeJobScheduler', 'obliterate true'].map(step => `${name} ${step}`)),
    ...Array(2).fill('del cmdb:schedule-config:v1:discovery')]);
  expect([...w.store.keys()].sort()).toEqual([...OTHER, ...(failOn === undefined ? [] : ['job:1', 'job:2', 'meta'].map(key => `bull:${failOn}:${key}`))].sort());
});
