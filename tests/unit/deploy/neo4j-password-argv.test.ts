/**
 * HAP-1647 / HAP-1666: no script or manifest may hand the Neo4j password to cypher-shell or
 * the Redis password to redis-cli in argv, where `ps`, /proc/<pid>/cmdline and `docker top`
 * show it. Host scripts use a name-only `docker exec -e NEO4J_PASSWORD` or an exported
 * REDISCLI_AUTH (the value travels in the environment); the k8s probes and the Redis init Job
 * derive it inside sh from the container env, as HAP-1379 (#188) did for the Compose
 * healthchecks. Unset password: abort-style scripts stop before any client call, check-style
 * scripts fail that check. HAP-1719: the k8s redis-server gets requirepass/masterauth from a
 * config file, not argv. Scripts only ever meet stubs here. HAP-1667: the scan reads every tracked command file, also
 * flags a Neo4j password flag built apart from the client call, and excuses only exact throwaway literals.
 */
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
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
// Every tracked file of these kinds anywhere in the repository (root deploy.sh included).
const COMMAND_FILE = /(\.(sh|bash|ya?ml|json|[cm]?js|ts|py|tf|cron|service)|(^|\/)Dockerfile[^/]*|(^|\/)Makefile)$/;
// Fixed non-secret literals a file may pass as a password value. Each entry excuses only those exact values in that
// file; any other password value there is still flagged.
const EXCEPTIONS: Record<string, string[]> = {
  // HAP-1647 D4 (operator follow-up): fixed throwaway passwords of ephemeral containers.
  'tests/e2e/docker-compose.e2e.yml': ['test_password'],
  'packages/etl-processor/tests/scratch/run-n18-receipt.sh': ['testpassword'],
  // The seed CLI's rejection of a password flag: its dummy value, and the `/` closing the expected-error regex.
  'packages/api-server/src/scripts/__tests__/seed-tenant-fixture.test.ts': ['x', '/'],
};
// A flag starts a word, a quoted string or a list item.
const AT_WORD = `(?<=^|[\\s"'[,(])`;
// Per client: its password flags (the Redis client's port flag and the Neo4j client's address flag are not among them)
// and the variable it reads instead. `apart`: files where a password flag away from the client's own line (an argv
// array built before the call) still counts.
const client = (bin: string, short: string, long: string, env: string, apart?: RegExp) => ({
  bin,
  apart,
  // On the client's line: attached (-p$X, -pX) or not.
  onLine: new RegExp(`${AT_WORD}(?:${short}(?!-)|${long}(?![\\w-]))`, 'g'),
  // Apart from it: a word of its own.
  offLine: new RegExp(`${AT_WORD}(?:${short}|${long})(?![\\w-])`, 'g'),
  envOption: new RegExp(`(?:-e\\s*|--env[\\s=]\\s*)["']?${env}=`, 'g'),
  assignment: new RegExp(`(?<![\\w-])${env}=`, 'g'),
});
const CLIENTS = [
  client(SHELL, '-' + 'p', '--' + 'password', 'NEO4J_PASSWORD', new RegExp(`\\bNEO4J_PASSWORD\\b|${SHELL}`)),
  client(REDIS_CLI, '-' + 'a', '--' + 'pass', 'REDISCLI_AUTH'),
];
// A non-secret value of a port-publishing flag: a port, host:port or <NAME>_PORT reference.
const PORT = /^[\d.:]+$|_PORT\b|:\d+$/;
// The option of one of these commands (mkdir, read, ps) is not a client flag.
const OTHER_COMMAND = /(?:^|[\s;|&(])(?:mkdir|read|ps)\s[^;|&]*$/;
const COMMENT = /^\s*(?:#|\/\/|\/\*|\*)/;
// A container runtime call: whatever follows it on the line is that process's argv.
const CONTAINER_CALL = /\b(?:docker|podman|kubectl)/;

/** The value after `index`: `=`-joined, attached, or the next shell word or list item, unquoted. */
function valueAt(line: string, index: number): string {
  return /^[=\s"',]*([^\s"',\])]*)/.exec(line.slice(index))![1];
}

/** In which quote `index` sits on a shell line: '' outside, `'` or `"`. */
function quoteAt(line: string, index: number): string {
  let quote = '';
  for (let i = 0; i < index; i++) {
    if (quote === "'") quote = line[i] === "'" ? '' : quote;
    else if (line[i] === '\\') i++;
    else if (line[i] === quote) quote = '';
    else if (!quote && (line[i] === "'" || line[i] === '"')) quote = line[i];
  }
  return quote;
}

const valuesAfter = (line: string, re: RegExp) => [...line.matchAll(re)].map((m) => ({ at: m.index!, value: valueAt(line, m.index! + m[0].length) }));

/** The password values one logical line hands a client in argv; `gated[i]`: the file is in CLIENTS[i].apart. */
function lineSecrets(line: string, gated: boolean[]): string[] {
  return CLIENTS.flatMap(({ bin, onLine, offLine, envOption, assignment }, i) => {
    if (line.includes(bin)) {
      // The flag, and the variable set as an argv word: -e/--env anywhere, any NAME=value after a container call (sh -c,
      // env). Only a single-quoted NAME="$X" there is not argv: the container's shell expands it from its own environment.
      const call = CONTAINER_CALL.exec(line);
      return [
        ...valuesAfter(line, onLine),
        ...valuesAfter(line, envOption),
        ...valuesAfter(line, assignment).filter(({ at, value }) => call && at > call.index && !(quoteAt(line, at) === "'" && value.startsWith('$'))),
      ].map(({ value }) => value);
    }
    if (!gated[i] || COMMENT.test(line)) return [];
    // Apart from the client's line, unless the flag belongs to mkdir/read/ps or publishes a port.
    return valuesAfter(line, offLine)
      .filter(({ at, value }) => !OTHER_COMMAND.test(line.slice(0, at)) && !PORT.test(value))
      .map(({ value }) => value);
  });
}

/** Logical lines of `file` that hand cypher-shell or redis-cli a password in argv, bar the file's excepted literals. */
function argvSecretLines(text: string, file = ''): string[] {
  const gated = CLIENTS.map(({ apart }) => apart?.test(text) ?? false);
  const excepted = EXCEPTIONS[file] ?? [];
  return logicalLines(text).filter((line) => lineSecrets(line, gated).some((value) => !excepted.includes(value)));
}

function commandFiles(files: string[]): string[] {
  return files.filter((file) => COMMAND_FILE.test(file));
}

function trackedCommandFiles(): string[] {
  const run = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ls-files failed: ${run.stderr}`);
  return commandFiles(run.stdout.split('\0'));
}

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

describe('HAP-1647 / HAP-1666 / HAP-1667 / HAP-1719: the Neo4j and Redis passwords never reach client or server argv', () => {
  let dir: string;
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  const sandboxEnv = () => ({ PATH: `${dir}:/usr/bin:/bin`, OUT: join(dir, 'out'), TMPDIR: dir });
  const bash = (script: string, ...args: string[]) =>
    spawnSync('bash', [script, ...args], { env: sandboxEnv(), encoding: 'utf8', timeout: 60_000 });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hap1647-'));
    // One env line per call; an empty line is a call without NEO4J_PASSWORD.
    stub(SHELL, 'printf "%s\\n" "$0" "$@" >> "$OUT.argv"\necho "${NEO4J_PASSWORD-}" >> "$OUT.env"');
    stub(REDIS_CLI, 'echo "$0 $*" >> "$OUT.redis-argv"\necho "${REDISCLI_AUTH-}" >> "$OUT.redis-env"');
    // docker: record every call; report the cmdb containers as running and healthy. exec runs a sandbox stub as the
    // container would: its environment holds only the -e variables, NAME=value as given, a bare NAME with the
    // caller's value. Other commands (psql) fail.
    stub('docker', [
      'echo "$*" >> "$OUT.calls"',
      'case "$1" in',
      '  ps) echo cmdb-neo4j cmdb-postgres cmdb-redis cmdb-api-server cmdb-web-ui;;',
      '  inspect) echo healthy;;',
      '  exec) shift; vars=()',
      '    while [[ $1 == -* ]]; do',
      '      if [[ $1 == -e || $1 == --env ]]; then shift; if [[ $1 == *=* ]]; then vars+=("$1"); elif [[ -v $1 ]]; then vars+=("$1=${!1}"); fi; fi',
      '      shift',
      '    done',
      '    [[ -x "${0%/*}/$2" ]] || exit 1',
      '    exec env -i PATH="$PATH" OUT="$OUT" "${vars[@]}" "${@:2}";;',
      'esac',
    ].join('\n'));
    stub('curl', 'printf "{}\\n200"');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const p = '-' + 'p';
  const lines = (texts: string[], file?: string) => texts.map((text) => argvSecretLines(text, file).length);

  it('on the Neo4j client line the scan flags the password flag in any spelling and NEO4J_PASSWORD=value in the exec argv', () => {
    expect(lines([
      `docker exec c ${SHELL} -u neo4j \\\n    ${p} "$P" 'RETURN 1'`,
      `docker exec c ${SHELL} -u neo4j ${p}$P 'RETURN 1'`,
      `docker exec c ${SHELL} -u neo4j ${p}"$P" 'RETURN 1'`,
      `docker exec c ${SHELL} -u neo4j -${p}assword="$P" 'RETURN 1'`,
      `docker exec -e NEO4J_PASSWORD="$P" c ${SHELL} -u neo4j 'RETURN 1'`,
      `docker exec --env NEO4J_PASSWORD="$P" c ${SHELL} -u neo4j 'RETURN 1'`,
      `docker exec --env=NEO4J_PASSWORD="$P" c ${SHELL} -u neo4j 'RETURN 1'`,
      `docker exec -eNEO4J_PASSWORD="$P" c ${SHELL} -u neo4j 'RETURN 1'`,
      `"$DOCKER" exec -e NEO4J_PASSWORD="$P" c ${SHELL} -u neo4j 'RETURN 1'`,
      `docker exec c sh -c "NEO4J_PASSWORD='$P' ${SHELL} -u neo4j 'RETURN 1'"`,
      `docker exec c sh -c 'NEO4J_PASSWORD=literal ${SHELL} -u neo4j "RETURN 1"'`,
      `docker exec c env NEO4J_PASSWORD="$P" ${SHELL} -u neo4j 'RETURN 1'`,
      `kubectl exec neo4j-0 -- env NEO4J_PASSWORD="$P" ${SHELL} -u neo4j 'RETURN 1'`,
    ])).toEqual(Array(13).fill(1));
    // Named safe forms: name-only -e; a host env prefix; an assignment the container's shell expands from its own env.
    expect(lines([
      `docker exec -e NEO4J_PASSWORD c ${SHELL} -u neo4j 'RETURN 1'`,
      `NEO4J_PASSWORD="$P" docker exec -e NEO4J_PASSWORD c ${SHELL} -u neo4j 'RETURN 1'`,
      `docker exec -e NEO4J_AUTH c sh -c 'NEO4J_PASSWORD="\${NEO4J_AUTH#*/}" exec ${SHELL} -u neo4j "RETURN 1"'`,
    ])).toEqual([0, 0, 0]);
  });

  it('in a file that runs the Neo4j client or names NEO4J_PASSWORD the scan flags a password flag built apart from the call', () => {
    expect(lines([
      `auth=(-u neo4j ${p} "$NEO4J_PASSWORD")\ndocker exec c ${SHELL} "\${auth[@]}" 'RETURN 1'`,
      `args+=(${p}"$pw")\ndocker exec c ${SHELL} "\${args[@]}"`,
      `spawnSync('docker', [\n  'exec', 'c', '${SHELL}',\n  '${p}', password,\n]);`,
      `subprocess.run(["${SHELL}", "-u", "neo4j",\n    "${p}", os.environ["NEO4J_PASSWORD"]])`,
      `command: ["${SHELL}"]\nargs:\n  - -u\n  - neo4j\n  - ${p}\n  - $(NEO4J_PASSWORD)`,
    ])).toEqual([1, 1, 1, 1, 1]);
    // Named safe forms there: mkdir/read/ps options, port publishing, comments; and -p in a file naming neither.
    expect(lines([
      [
        `: "\${NEO4J_PASSWORD:?}"`,
        `mkdir -m 700 ${p} "$DIR"`,
        `read -r ${p} "Proceed? " answer`,
        `if ps ${p} $PID > /dev/null; then :; fi`,
        `docker run -d ${p} "$NEO4J_PORT:7687" ${p} 127.0.0.1::7474 neo4j`,
        `# without ${p} it prompts`,
      ].join('\n'),
      `psql ${p} "$PGPORT_FILE"`,
    ])).toEqual([0, 0]);
  });

  it('an exception excuses only its exact throwaway literal, and only in its own file', () => {
    const file = 'packages/etl-processor/tests/scratch/run-n18-receipt.sh';
    expect(lines([`docker exec c ${SHELL} -u neo4j ${p} testpassword`, `docker exec c ${SHELL} -u neo4j ${p} "$NEO4J_PASSWORD"`], file))
      .toEqual([0, 1]);
    expect(lines([`docker exec c ${SHELL} -u neo4j ${p} testpassword`], 'scripts/db-init.sh')).toEqual([1]);
  });

  it('the scan covers the root deploy.sh and cron, systemd, Terraform and Python files', () => {
    const files = ['deploy.sh', 'ops/backup.cron', 'ops/backup.service', 'infra/main.tf', 'tools/seed.py', 'Dockerfile'];
    expect(commandFiles(files)).toEqual(files);
    expect(trackedCommandFiles()).toEqual(expect.arrayContaining(['deploy.sh', 'infrastructure/config/cron/happycmdb-backup.cron']));
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

  it('no tracked script, workflow or manifest passes it in argv (excepted literals only)', () => {
    const hits = trackedCommandFiles()
      .flatMap((file) => argvSecretLines(readFileSync(join(REPO, file), 'utf8'), file).map((line) => `${file}: ${line.trim()}`));
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
    }).toEqual({ argv: false, env: `${GENERATED}\n` });
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

  it('post-deploy-validation hands a set NEO4J_PASSWORD to cypher-shell through the container environment, never argv', () => {
    const scripts = join(dir, 'root/infrastructure/scripts');
    mkdirSync(scripts, { recursive: true });
    copyFileSync(join(REPO, 'infrastructure/scripts/post-deploy-validation.sh'), join(scripts, 'post-deploy-validation.sh'));
    const run = spawnSync('bash', [join(scripts, 'post-deploy-validation.sh')], {
      env: { ...sandboxEnv(), NEO4J_PASSWORD: GENERATED },
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect({
      connected: run.stdout.includes('Neo4j connection successful'),
      argv: readFileSync(join(dir, 'out.argv'), 'utf8').includes(GENERATED),
      env: readFileSync(join(dir, 'out.env'), 'utf8'),
      output: `${run.stdout}${run.stderr}`.includes(GENERATED),
    }).toEqual({ connected: true, argv: false, env: `${GENERATED}\n${GENERATED}\n`, output: false });
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

  // HAP-1719 rows: redis-server takes requirepass/masterauth from a config file that an init
  // container builds from the cmdb-secrets env into a shared volume, never from its own argv.
  type Mount = { name: string; mountPath: string };
  type Container = { name: string; command: string[]; args?: string[]; env?: { name: string }[]; volumeMounts?: Mount[] };
  const redisPod = () => {
    const manifest = readFileSync(join(REPO, 'infrastructure/kubernetes/statefulsets/redis-statefulset.yaml'), 'utf8');
    const spec = parseAllDocuments(manifest).map((doc) => doc.toJS()).find((doc) => doc.kind === 'StatefulSet').spec.template.spec;
    const redis: Container = spec.containers.find((c: Container) => c.name === 'redis');
    // The init container that mounts a volume the redis container also mounts.
    const init: Container | undefined = (spec.initContainers ?? []).find((c: Container) =>
      c.volumeMounts?.some((m) => redis.volumeMounts?.some((r) => r.name === m.name)));
    return { spec, redis, init };
  };
  // An exec array as the kubelet starts it: $(VAR) expanded from env, each volume mountPath
  // mapped to one sandbox directory per volume name.
  const podArgv = (c: Container, env: Record<string, string>) =>
    [...c.command, ...(c.args ?? [])].map((arg) => {
      let out = arg.replace(/\$\((\w+)\)/g, (ref, name) => env[name] ?? ref);
      for (const m of c.volumeMounts ?? []) out = out.split(m.mountPath).join(join(dir, 'vol', m.name));
      return out;
    });
  const runInPod = (c: Container, env: Record<string, string>) => {
    const [cmd, ...args] = podArgv(c, env);
    return spawnSync(cmd, args, { env, encoding: 'utf8' });
  };
  // Redis config parsing (sdssplitargs): a double-quoted value with \xHH, \n, \r, \t, \b, \a, \\ and \".
  const redisConfig = (text: string) => {
    const named: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07' };
    return Object.fromEntries(text.split('\n').filter((line) => line.trim()).map((line) => {
      const m = /^(\S+) "((?:[^"\\]|\\.)*)"$/.exec(line);
      if (!m) throw new Error(`unparsed config line: ${line}`);
      return [m[1], Buffer.from(m[2].replace(/\\x([0-9a-fA-F]{2})|\\(.)/g, (_, hex, ch) =>
        hex ? String.fromCharCode(parseInt(hex, 16)) : named[ch] ?? ch), 'latin1').toString('utf8')];
    }));
  };

  it('HAP-1719: redis-server reads requirepass and masterauth from the init-built auth file, never argv', () => {
    const { spec, redis, init } = redisPod();
    expect(init).toBeDefined();
    // A password with quotes, backslashes, a space, a non-ASCII char and a trailing newline.
    const password = `${GENERATED} "\\' $x\u00e9\n`;
    for (const m of [...(init?.volumeMounts ?? []), ...(redis.volumeMounts ?? [])]) mkdirSync(join(dir, 'vol', m.name), { recursive: true });
    // Every external command the init script runs logs its argv, then runs the real binary.
    for (const bin of ['od', 'tr', 'sed', 'cat', 'base64', 'xxd', 'awk']) {
      const real = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).stdout.trim();
      if (real) stub(bin, `printf '%s\\n' "$*" >> "$OUT.init-argv"\nexec ${real} "$@"`);
    }
    const env = { ...sandboxEnv(), REDIS_PASSWORD: password } as Record<string, string>;
    const initRun = runInPod(init as Container, env);
    const server = podArgv(redis, env);
    const confPath = server[1];
    const shared = (init?.volumeMounts ?? []).map((m) => m.name);
    const volume = spec.volumes.find((v: { name: string }) => shared.includes(v.name));
    const initArgv = existsSync(join(dir, 'out.init-argv')) ? readFileSync(join(dir, 'out.init-argv'), 'utf8') : '';

    expect({
      status: initRun.status,
      initArgv: initArgv.includes(GENERATED) || podArgv(init as Container, env).join(' ').includes(GENERATED),
      initOutput: `${initRun.stdout}${initRun.stderr}`.includes(GENERATED),
      serverArgv: server.join(' ').includes(GENERATED),
      // In memory, never on node disk, and readable by the owner only.
      volume: volume?.emptyDir,
      confMode: (statSync(confPath).mode & 0o777).toString(8),
    }).toEqual({ status: 0, initArgv: false, initOutput: false, serverArgv: false, volume: { medium: 'Memory', sizeLimit: '1Mi' }, confMode: '600' });
    // The config file is redis-server's first argument and carries both directives.
    expect(server[0]).toBe('redis-server');
    expect(redisConfig(readFileSync(confPath, 'latin1'))).toEqual({ requirepass: password, masterauth: password });
  });

  it.each([
    ['unset', {}],
    ['empty', { REDIS_PASSWORD: '' }],
  ])('HAP-1719: the auth init container aborts, naming the variable, and writes no file when it is %s', (_, extra) => {
    const { init } = redisPod();
    expect(init).toBeDefined();
    for (const m of init?.volumeMounts ?? []) mkdirSync(join(dir, 'vol', m.name), { recursive: true });
    const run = runInPod(init as Container, { ...sandboxEnv(), ...extra });

    expect({
      status: run.status === 0 ? 0 : 'failed',
      named: run.stderr.includes('REDIS_PASSWORD'),
      files: (init?.volumeMounts ?? []).flatMap((m) => readdirSync(join(dir, 'vol', m.name))),
    }).toEqual({ status: 'failed', named: true, files: [] });
  });
});
