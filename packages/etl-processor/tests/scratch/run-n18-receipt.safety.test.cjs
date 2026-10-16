// Run with: node --test packages/etl-processor/tests/scratch/run-n18-receipt.safety.test.cjs
// All Docker and Git calls resolve to temporary fake executables; no store or daemon is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const runner = path.join(__dirname, 'run-n18-receipt.sh');
const head = 'a'.repeat(40);
const realTimeout = '/usr/bin/timeout';

async function executable(file, content) {
  await fs.writeFile(file, content, { mode: 0o700 });
}

async function scenario(mode, poison = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'n18-runner-safety-'));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  await fs.mkdir(path.join(root, 'node_modules/.bin'), { recursive: true });
  await executable(path.join(root, 'node_modules/.bin/jest'), '#!/bin/sh\nexit 0\n');
  await fs.writeFile(path.join(root, 'victim'), 'unchanged\n');
  await executable(path.join(bin, 'git'), `#!/bin/bash
case "$1 $2" in
  'rev-parse --show-toplevel') printf '%s\\n' "$SANDBOX" ;;
  'rev-parse HEAD') printf '%s\\n' "$HEAD_ID" ;;
  'status --porcelain')
    if [[ -n $POISON ]]; then
      mkdir -p "$SANDBOX/test-results/n18"
      ln -s "$SANDBOX/victim" "$SANDBOX/test-results/n18/\${HEAD_ID:0:12}-$PPID.$POISON"
    fi ;;
  *) exit 9 ;;
esac
`);
  // Shorten only the runner's Docker deadlines, using the real timeout binary.
  // Jest never starts in these fail-closed cases.
  await executable(path.join(bin, 'timeout'), `#!/bin/bash
while [[ $1 == --* ]]; do shift; done
shift
exec "$REAL_TIMEOUT" --signal=TERM --kill-after=0.1s 0.5s "$@"
`);
  await executable(path.join(bin, 'docker'), `#!/bin/bash
set -eu
command=$1; shift
case "$command" in
  pull) exit 0 ;;
  run)
    name='' session='' run=''
    while (( $# )); do
      case "$1" in
        --name) name=$2; shift 2 ;;
        --label)
          case "$2" in ao.session=*) session=\${2#*=} ;; n18.run=*) run=\${2#*=} ;; esac
          shift 2 ;;
        *) shift ;;
      esac
    done
    printf 'started\\n' > "$SANDBOX/run-entered"
    case "$MODE" in
      stalled-run)
        ( sleep 0.2; printf '%s|%s\\n' "$session" "$run" > "$SANDBOX/$name" ) >/dev/null 2>&1 &
        sleep 30 ;;
      stalled-cleanup|stalled-remove|immediate)
        printf '%s|%s\\n' "$session" "$run" > "$SANDBOX/$name"; exit 1 ;;
      delayed)
        ( sleep 0.4; printf '%s|%s\\n' "$session" "$run" > "$SANDBOX/$name" ) >/dev/null 2>&1 &
        exit 1 ;;
      invisible) exit 1 ;;
      collision) printf 'foreign|foreign\\n' > "$SANDBOX/$name"; exit 1 ;;
    esac ;;
  container)
    [[ $1 == ls ]] || exit 9; shift
    if [[ $MODE == stalled-cleanup && ! -e $SANDBOX/lookup-entered ]]; then
      printf 'started\\n' > "$SANDBOX/lookup-entered"
      sleep 30
    fi
    name='' session='' run=''
    while (( $# )); do
      if [[ $1 == --filter ]]; then
        case "$2" in
          name=*) name=\${2#name=^/}; name=\${name%\$} ;;
          label=ao.session=*) session=\${2#label=ao.session=} ;;
          label=n18.run=*) run=\${2#label=n18.run=} ;;
        esac
        shift 2
      else shift; fi
    done
    if [[ -f $SANDBOX/$name && $(cat "$SANDBOX/$name") == "$session|$run" ]]; then
      printf '%s\\n' "$name"
    fi ;;
  rm)
    [[ $1 == -f ]] || exit 9
    if [[ $MODE == stalled-remove ]]; then sleep 30; fi
    rm -f -- "$SANDBOX/$2" ;;
  *) exit 9 ;;
esac
`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(POSTGRES_|DATABASE_URL$|PGHOST$|PGPORT$|PGDATABASE$|PGUSER$|PGPASSWORD$|NEO4J_|REDIS_|AWS_|AZURE_|GCP_|GOOGLE_APPLICATION_CREDENTIALS$)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    PATH: `${bin}:${process.env.PATH}`, SANDBOX: root, HEAD_ID: head,
    MODE: mode, POISON: poison, REAL_TIMEOUT: realTimeout, AO_SESSION_ID: 'n18-fake',
  });
  try {
    const child = spawn('bash', [runner, head], { cwd: root, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    if (mode === 'stalled-run') {
      const until = Date.now() + 4000;
      while (Date.now() < until) {
        if (await fs.stat(path.join(root, 'run-entered')).then(() => true, () => false)) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(await fs.stat(path.join(root, 'run-entered')).then(() => true, () => false), true);
      child.kill('SIGTERM');
    }
    const status = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Runner hung in ${mode}`)); }, 20000);
      child.once('error', reject);
      child.once('close', code => { clearTimeout(deadline); resolve(code); });
    });
    const owned = (await fs.readdir(root)).filter(name => name.startsWith('n18-pg-'));
    const victim = await fs.readFile(path.join(root, 'victim'), 'utf8');
    const receipts = await fs.readdir(path.join(root, 'test-results/n18')).catch(() => []);
    const runLog = receipts.find(name => name.endsWith('.run.log'));
    const log = runLog ? await fs.readFile(path.join(root, 'test-results/n18', runLog), 'utf8') : '';
    return { status, stdout, stderr, owned, victim, log };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('Docker client deadlines reconcile delayed creation after an interrupted foreground run', async () => {
  const result = await scenario('stalled-run');
  assert.equal(result.status, 143, result.stderr);
  assert.deepEqual(result.owned, []);
  assert.match(result.log, /N18_TEARDOWN=ok N18_EXIT_STATUS=143/);
});

test('stalled cleanup lookup times out, reports failure, and removes the owned container', async () => {
  const result = await scenario('stalled-cleanup');
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.owned, []);
  assert.match(result.stdout, /N18_TEARDOWN=failed/);
});

test('stalled cleanup removal times out and never reports successful teardown', async () => {
  const result = await scenario('stalled-remove');
  assert.notEqual(result.status, 0);
  assert.equal(result.owned.length, 1);
  assert.match(result.log, /N18_TEARDOWN=failed/);
});

test('immediate and delayed creation are removed; invisible creation and foreign collision fail closed', async () => {
  for (const mode of ['immediate', 'delayed', 'invisible', 'collision']) {
    const result = await scenario(mode);
    assert.notEqual(result.status, 0, mode);
    assert.deepEqual(result.owned.length, mode === 'collision' ? 1 : 0, mode);
    assert.match(result.stdout, mode === 'invisible' || mode === 'collision' ? /N18_UNRECONCILED=.*N18_TEARDOWN=failed/s : /N18_TEARDOWN=ok/, mode);
  }
});

test('all ignored artifact leaf symlinks are refused before Docker and do not overwrite their target', async () => {
  for (const leaf of ['jsonl', 'run.log', 'migrations.log', 'junit.xml']) {
    const result = await scenario('poison', leaf);
    assert.equal(result.status, 2, leaf);
    assert.match(result.stderr, /Refusing existing receipt artifact/, leaf);
    assert.equal(result.victim, 'unchanged\n', leaf);
  }
});
