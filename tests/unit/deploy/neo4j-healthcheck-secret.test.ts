/**
 * HAP-1379: the Neo4j Compose healthcheck must not carry the password in argv.
 *
 * Compose interpolates `${VAR}` at config time, so a password in the test array is
 * stored in `docker inspect` (Config.Healthcheck.Test), and every run puts it in the
 * exec's cmdline (`ps`, `docker top`, /proc/<pid>/cmdline). The check must instead
 * take the password from the container's own NEO4J_AUTH when it runs and hand it to
 * cypher-shell through its NEO4J_PASSWORD environment variable.
 *
 * Each healthcheck is run as Docker would (CMD: exec argv; CMD-SHELL: /bin/sh -c)
 * against a stub cypher-shell that records the argv and environment it received.
 */
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { parse } from 'yaml';

const REPO = resolve(__dirname, '../../..');
// Generated per run so no fixed credential-shaped literal lives in the repo.
const GENERATED = randomBytes(12).toString('hex');

// Compose interpolation of the values these files use: `$$` escapes a literal `$`.
const interpolate = (value: string): string =>
  value.replace(/\$\$|\$\{NEO4J_PASSWORD(?:[:?][^}]*)?\}|\$\{?\w/g, (m) => {
    if (m === '$$') return '$';
    if (m.startsWith('${NEO4J_PASSWORD')) return GENERATED;
    throw new Error(`unmodelled interpolation near ${m}`);
  });

function neo4jService(file: string): { test: string[]; auth: string } {
  const neo4j = parse(readFileSync(resolve(REPO, file), 'utf8')).services.neo4j;
  const env = neo4j.environment;
  const auth = Array.isArray(env)
    ? env.find((e: string) => e.startsWith('NEO4J_AUTH='))?.slice('NEO4J_AUTH='.length)
    : env?.NEO4J_AUTH;
  if (typeof auth !== 'string') throw new Error(`${file}: neo4j has no NEO4J_AUTH`);
  return {
    test: neo4j.healthcheck.test.map((arg: string) => interpolate(arg)),
    auth: interpolate(auth),
  };
}

describe.each([
  'deploy/build01-staging.compose.yml',
  'infrastructure/docker/docker-compose.yml',
  'infrastructure/docker/docker-compose.test.yml',
])('%s neo4j healthcheck', (file) => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hap1379-'));
    const stub = join(dir, 'cypher-shell');
    writeFileSync(
      stub,
      '#!/bin/sh\nprintf "%s\\n" "$0" "$@" > "$OUT.argv"\nprintf "%s" "${NEO4J_PASSWORD-}" > "$OUT.env"\n'
    );
    chmodSync(stub, 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('authenticates via NEO4J_PASSWORD from NEO4J_AUTH, with no password in argv', () => {
    const { test, auth } = neo4jService(file);
    const expected = auth.slice(auth.indexOf('/') + 1);
    const out = join(dir, 'out');
    const env = { PATH: `${dir}:/usr/bin:/bin`, NEO4J_AUTH: auth, OUT: out };
    const [kind, ...args] = test;
    const run =
      kind === 'CMD-SHELL'
        ? spawnSync('/bin/sh', ['-c', args[0]], { env })
        : spawnSync(args[0], args.slice(1), { env });

    expect(run.status).toBe(0);
    expect({
      inspectedTest: test.some((arg) => arg.includes(expected)),
      cypherShellArgv: readFileSync(`${out}.argv`, 'utf8').includes(expected),
      cypherShellEnv: readFileSync(`${out}.env`, 'utf8'),
    }).toEqual({ inspectedTest: false, cypherShellArgv: false, cypherShellEnv: expected });
  });
});
