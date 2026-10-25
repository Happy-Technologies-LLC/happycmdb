/**
 * Repo-hygiene guard (HAP-955): no compiled tsc output is tracked beside TypeScript source in any
 * packages/<pkg>/src tree. Jest's default moduleFileExtensions and Node's CommonJS resolver try
 * x.js before x.ts, so a tracked twin silently replaces the source that CI tests and dist/ builds.
 * Ambient .d.ts files without a .ts sibling (common/src/env.d.ts, discovery-engine's
 * types/node-nmap.d.ts) stay allowed.
 */
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../../..');
const EMITTED = /\.(d\.ts\.map|js\.map|d\.ts|js)$/;

it('tracks no compiled .js/.d.ts/source-map twin under packages/*/src', () => {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', ':(glob)packages/**/src/**'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
  const files = new Set(tracked);
  const hasTsSibling = (f: string): boolean =>
    ['.ts', '.tsx'].some((ext) => files.has(f.replace(EMITTED, '') + ext));
  expect(tracked.filter((f) => f.endsWith('.map') || (EMITTED.test(f) && hasTsSibling(f)))).toEqual([]);
});

// rotate-user-password.ts reaches the database clients through these relative src imports, and
// deploy.sh tells operators to run it with `npx ts-node`, whose require hook only appends .ts after
// Node's built-in .js/.json/.node. A compiled twin there would load the stale postgres/client.js,
// which logged raw query text and errors. Probed in a child process with an empty env: inside Jest,
// resolution is Jest's own ts-first resolver, and NODE_OPTIONS loaders must not leak in.
it('operator-stores database imports resolve to no compiled file ahead of their .ts source', () => {
  const scripts = resolve(REPO_ROOT, 'packages/api-server/src/scripts');
  const source = readFileSync(resolve(scripts, 'operator-stores.ts'), 'utf8');
  const specs = [...source.matchAll(/from '(\.\.\/[^']*\/database\/src\/[^']+)'/g)].map((m) => m[1]);
  expect(specs).toEqual(['../../../database/src/neo4j/client', '../../../database/src/postgres/client']);
  specs.forEach((spec) => expect(existsSync(resolve(scripts, `${spec}.ts`))).toBe(true));
  const probe = spawnSync(
    process.execPath,
    ['-e', `for (const s of ${JSON.stringify(specs)}) { try { console.log(require.resolve(s)); } catch (e) { console.log(e.code); } }`],
    { cwd: scripts, encoding: 'utf8', env: {} }
  );
  expect(probe.stdout.trim().split('\n')).toEqual(['MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);
});
