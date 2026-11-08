/**
 * HAP-1647 / HAP-1666: no script or manifest may hand the Neo4j password to cypher-shell or
 * the Redis password to redis-cli in argv, where `ps`, /proc/<pid>/cmdline and `docker top`
 * show it. Host scripts use a name-only `docker exec -e NEO4J_PASSWORD` or an exported
 * REDISCLI_AUTH (the value travels in the environment); the k8s probes and the Redis init Job
 * derive it inside sh from the container env, as HAP-1379 (#188) did for the Compose
 * healthchecks. Unset password: abort-style scripts stop before any client call, check-style
 * scripts fail that check. Scripts only ever meet stubs here.
 */
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { gzipSync } from 'zlib';
import { parseAllDocuments } from 'yaml';

const REPO = resolve(__dirname, '../../..');
// Generated per run so no fixed credential-shaped literal lives in the repo.
const GENERATED = randomBytes(12).toString('hex');
// Split so this file's own fixtures never match its scan (no self-exclusion needed).
const SHELL = 'cypher' + '-shell';
const REDIS_CLI = 'redis' + '-cli';
const ROOTS = ['infrastructure', 'scripts', 'deploy', '.github', 'tests', 'packages'];
const COMMAND_FILE = /(\.(sh|bash|ya?ml|json|[cm]?js|ts)|\/Dockerfile[^/]*|\/Makefile)$/;
const EXCEPTIONS: Record<string, string> = {
  'tests/e2e/docker-compose.e2e.yml': 'fixed throwaway password of an ephemeral e2e container; operator follow-up (HAP-1647 D4)',
  'packages/etl-processor/tests/scratch/run-n18-receipt.sh': 'fixed throwaway password of an ephemeral scratch container; operator follow-up (HAP-1647 D4)',
};
// Per client: the argv flags that carry the password (the Redis client's -p is the port, the
// Neo4j client's -a the address) and the docker exec -e form that carries its value.
const CLIENTS = [
  { bin: SHELL, flag: /(?:^|[\s"'[,])(?:-p|--password)(?=[\s"'=,\]]|$)/, valueInExec: /-e\s+["']?NEO4J_PASSWORD=/ },
  { bin: REDIS_CLI, flag: /(?:^|[\s"'[,])(?:-a|--pass)(?=[\s"'=,\]]|$)/, valueInExec: /-e\s+["']?REDISCLI_AUTH=/ },
];

/**
 * Logical lines: backslash continuations are joined, and so are consecutive same-indent YAML
 * `- item` lines (an exec array; comment lines between items keep the array open).
 */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  let seq: { indent: string; at: number } | undefined;
  for (const line of text.replace(/\\\r?\n/g, ' ').split('\n')) {
    const item = /^(\s*)- (.*)$/.exec(line);
    if (item && seq && item[1] === seq.indent) {
      out[seq.at] += ` ${item[2]}`;
      continue;
    }
    out.push(line);
    if (item) seq = { indent: item[1], at: out.length - 1 };
    else if (!/^\s*#/.test(line)) seq = undefined;
  }
  return out;
}

/** Logical lines that give cypher-shell or redis-cli the password in argv. */
function argvSecretLines(text: string): string[] {
  return logicalLines(text).filter((line) =>
    CLIENTS.some(({ bin, flag, valueInExec }) => line.includes(bin) && (flag.test(line) || valueInExec.test(line))),
  );
}

function trackedCommandFiles(): string[] {
  const run = spawnSync('git', ['ls-files', '-z', '--', ...ROOTS], { cwd: REPO, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ls-files failed: ${run.stderr}`);
  return run.stdout.split('\0').filter((file) => COMMAND_FILE.test(`/${file}`));
}

describe('HAP-1647 / HAP-1666: the Neo4j and Redis passwords never reach client argv', () => {
  let dir: string;
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  const sandboxEnv = () => ({ PATH: `${dir}:/usr/bin:/bin`, OUT: join(dir, 'out'), TMPDIR: dir });
  const bash = (script: string, ...args: string[]) =>
    spawnSync('bash', [script, ...args], { env: sandboxEnv(), encoding: 'utf8', timeout: 60_000 });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hap1647-'));
    stub(SHELL, 'printf "%s\\n" "$0" "$@" > "$OUT.argv"\nprintf "%s" "${NEO4J_PASSWORD-}" > "$OUT.env"');
    stub(REDIS_CLI, 'echo "$0 $*" >> "$OUT.redis-argv"\necho "${REDISCLI_AUTH-}" >> "$OUT.redis-env"');
    // docker: record every call; report the cmdb containers as running and healthy.
    stub('docker', 'echo "$*" >> "$OUT.calls"\ncase "$1" in ps) echo cmdb-neo4j cmdb-postgres cmdb-redis cmdb-api-server cmdb-web-ui;; inspect) echo healthy;; esac');
    stub('curl', 'printf "{}\\n200"');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('the scan flags -p (even on a continuation line) and -e NEO4J_PASSWORD=value, not the name-only form', () => {
    const p = '-' + 'p';
    expect(argvSecretLines(`docker exec -e NEO4J_PASSWORD c ${SHELL} -u neo4j 'RETURN 1'`)).toEqual([]);
    expect(argvSecretLines(`docker exec c ${SHELL} -u neo4j \\\n    ${p} "$P" 'RETURN 1'`)).toHaveLength(1);
    expect(argvSecretLines(`docker exec -e NEO4J_PASSWORD="$P" c ${SHELL} -u neo4j 'RETURN 1'`)).toHaveLength(1);
  });

  it('the Redis scan flags the auth flag inline, in a YAML exec array and as -e REDISCLI_AUTH=value', () => {
    expect([
      `${REDIS_CLI} -a "$P" --cluster create $NODES`,
      `exec:\n  command:\n    - ${REDIS_CLI}\n    # comment\n    - -a\n    - $(REDIS_PASSWORD)\n    - ping`,
      `docker exec -e REDISCLI_AUTH="$P" c ${REDIS_CLI} ping`,
    ].map((text) => argvSecretLines(text).length)).toEqual([1, 1, 1]);
    // Named safe forms: env prefix; port -p; name-only -e; the Neo4j client's address -a.
    expect(argvSecretLines([
      `REDISCLI_AUTH="$REDIS_PASSWORD" exec ${REDIS_CLI} ping`,
      `${REDIS_CLI} -h redis-1 -p 6379 cluster info`,
      `docker exec -e REDISCLI_AUTH c ${REDIS_CLI} ping`,
      `${SHELL} -a bolt://localhost:7687 -u neo4j`,
    ].join('\n'))).toEqual([]);
  });

  it('no tracked script, workflow or manifest passes it in argv (named exceptions only)', () => {
    const hits = trackedCommandFiles()
      .filter((file) => !(file in EXCEPTIONS))
      .flatMap((file) => argvSecretLines(readFileSync(join(REPO, file), 'utf8')).map((line) => `${file}: ${line.trim()}`));
    expect(hits).toEqual([]);
  });

  it('the k8s liveness probe passes NEO4J_PASSWORD from the container NEO4J_AUTH via env', () => {
    const manifest = readFileSync(join(REPO, 'infrastructure/kubernetes/statefulsets/neo4j-statefulset.yaml'), 'utf8');
    const statefulSet = parseAllDocuments(manifest).map((doc) => doc.toJS()).find((doc) => doc.kind === 'StatefulSet');
    const neo4j = statefulSet.spec.template.spec.containers.find((c: { name: string }) => c.name === 'neo4j');
    expect(neo4j.env.map((e: { name: string }) => e.name)).toContain('NEO4J_AUTH');
    const [cmd, ...args]: string[] = neo4j.livenessProbe.exec.command;
    const run = spawnSync(cmd, args, { env: { ...sandboxEnv(), NEO4J_AUTH: `neo4j/${GENERATED}` } });

    expect(run.status).toBe(0);
    expect({
      argv: readFileSync(join(dir, 'out.argv'), 'utf8').includes(GENERATED),
      env: readFileSync(join(dir, 'out.env'), 'utf8'),
    }).toEqual({ argv: false, env: GENERATED });
  });

  it('abort style: restore-neo4j exits, naming the variable, before any docker call when it is unset', () => {
    const backup = join(dir, 'neo4j.dump.gz');
    writeFileSync(backup, gzipSync('dump'));
    const run = bash(join(REPO, 'infrastructure/scripts/restore-neo4j.sh'), '--file', backup);

    expect({
      status: run.status,
      named: run.stderr.includes('NEO4J_PASSWORD'),
      dockerCalled: existsSync(join(dir, 'out.calls')),
    }).toEqual({ status: 1, named: true, dockerCalled: false });
  });

  it('check style: post-deploy-validation fails the Neo4j check without running cypher-shell when it is unset', () => {
    // A copy, so PROJECT_ROOT (and any .env it sources) resolves inside the sandbox.
    const scripts = join(dir, 'root/infrastructure/scripts');
    mkdirSync(scripts, { recursive: true });
    copyFileSync(join(REPO, 'infrastructure/scripts/post-deploy-validation.sh'), join(scripts, 'post-deploy-validation.sh'));
    const run = bash(join(scripts, 'post-deploy-validation.sh'));

    expect({
      status: run.status,
      named: run.stdout.includes('NEO4J_PASSWORD'),
      cypherShellRun: readFileSync(join(dir, 'out.calls'), 'utf8').includes(SHELL),
    }).toEqual({ status: 1, named: true, cypherShellRun: false });
  });

  // HAP-1666 rows: sleep is stubbed so the scripts' startup waits cost nothing.
  const redisCalls = () => ({
    argv: existsSync(join(dir, 'out.redis-argv')) ? readFileSync(join(dir, 'out.redis-argv'), 'utf8') : '',
    // One line per call; an empty line is a call without REDISCLI_AUTH.
    env: existsSync(join(dir, 'out.redis-env')) ? readFileSync(join(dir, 'out.redis-env'), 'utf8').split('\n').slice(0, -1) : [],
  });

  it('abort style: init-redis-cluster exits, naming the variable, before any redis client call when it is unset', () => {
    stub('sleep', ':');
    const run = bash(join(REPO, 'infrastructure/scripts/init-redis-cluster.sh'));

    expect({ status: run.status, named: run.stderr.includes('REDIS_PASSWORD'), called: existsSync(join(dir, 'out.redis-argv')) })
      .toEqual({ status: 1, named: true, called: false });
  });

  it('init-redis-cluster hands all three redis client calls the password via REDISCLI_AUTH, never argv or output', () => {
    stub('sleep', ':');
    const script = join(REPO, 'infrastructure/scripts/init-redis-cluster.sh');
    const run = spawnSync('bash', [script], { env: { ...sandboxEnv(), REDIS_PASSWORD: GENERATED }, encoding: 'utf8' });
    const { argv, env } = redisCalls();

    expect({ status: run.status, argv: argv.includes(GENERATED), output: `${run.stdout}${run.stderr}`.includes(GENERATED), env })
      .toEqual({ status: 0, argv: false, output: false, env: [GENERATED, GENERATED, GENERATED] });
  });

  it('the k8s redis probes and init Job pass REDISCLI_AUTH from the container REDIS_PASSWORD via env', () => {
    stub('sleep', ':');
    const manifest = readFileSync(join(REPO, 'infrastructure/kubernetes/statefulsets/redis-statefulset.yaml'), 'utf8');
    const docs = parseAllDocuments(manifest).map((doc) => doc.toJS());
    const redis = docs.find((doc) => doc.kind === 'StatefulSet').spec.template.spec.containers.find((c: { name: string }) => c.name === 'redis');
    const job = docs.find((doc) => doc.kind === 'Job').spec.template.spec.containers[0];
    const env = { ...sandboxEnv(), REDIS_PASSWORD: GENERATED } as Record<string, string>;
    const statuses = [redis.livenessProbe.exec.command, redis.readinessProbe.exec.command, [...job.command, ...job.args]].map((exec: string[]) => {
      // The kubelet expands $(VAR) in exec arrays before the process starts.
      const [cmd, ...args] = exec.map((arg) => arg.replace(/\$\((\w+)\)/g, (ref, name) => env[name] ?? ref));
      return spawnSync(cmd, args, { env }).status;
    });

    expect([redis, job].map((c) => c.env.map((e: { name: string }) => e.name).includes('REDIS_PASSWORD'))).toEqual([true, true]);
    expect({ statuses, argv: redisCalls().argv.includes(GENERATED), env: redisCalls().env })
      .toEqual({ statuses: [0, 0, 0], argv: false, env: [GENERATED, GENERATED, GENERATED] });
  });
});
