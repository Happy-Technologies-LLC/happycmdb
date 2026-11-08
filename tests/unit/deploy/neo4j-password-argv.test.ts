/**
 * HAP-1647: no script or manifest may hand the Neo4j password to cypher-shell in argv,
 * where `ps`, /proc/<pid>/cmdline and `docker top` show it. Host scripts use a name-only
 * `docker exec -e NEO4J_PASSWORD` (the value travels in the exported environment); the
 * k8s probe derives it from the container's NEO4J_AUTH inside sh, as HAP-1379 (#188) did
 * for the Compose healthchecks. Unset password: abort-style scripts stop before any
 * docker call, check-style scripts fail that check. Scripts only ever meet stubs here.
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
const ROOTS = ['infrastructure', 'scripts', 'deploy', '.github', 'tests', 'packages'];
const COMMAND_FILE = /(\.(sh|bash|ya?ml|json|[cm]?js|ts)|\/Dockerfile[^/]*|\/Makefile)$/;
const EXCEPTIONS: Record<string, string> = {
  'tests/e2e/docker-compose.e2e.yml': 'fixed throwaway password of an ephemeral e2e container; operator follow-up (HAP-1647 D4)',
  'packages/etl-processor/tests/scratch/run-n18-receipt.sh': 'fixed throwaway password of an ephemeral scratch container; operator follow-up (HAP-1647 D4)',
};
const FLAG = /(?:^|[\s"'[,])(?:-p|--password)(?=[\s"'=,\]]|$)/;
const VALUE_IN_EXEC = /-e\s+["']?NEO4J_PASSWORD=/;

/** Logical lines (backslash continuations joined) that give cypher-shell the password in argv. */
function argvSecretLines(text: string): string[] {
  return text
    .replace(/\\\r?\n/g, ' ')
    .split('\n')
    .filter((line) => line.includes(SHELL) && (FLAG.test(line) || VALUE_IN_EXEC.test(line)));
}

function trackedCommandFiles(): string[] {
  const run = spawnSync('git', ['ls-files', '-z', '--', ...ROOTS], { cwd: REPO, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ls-files failed: ${run.stderr}`);
  return run.stdout.split('\0').filter((file) => COMMAND_FILE.test(`/${file}`));
}

describe('HAP-1647: the Neo4j password never reaches cypher-shell argv', () => {
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
});
