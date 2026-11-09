/**
 * HAP-1748: the Neo4j backup the deploy writes is the one the rollback restores. backup-neo4j.sh --to FILE dumps the
 * stopped Community DBMS into FILE, restore-neo4j.sh --check verifies it, and rollback.sh restores it over the live
 * database only with --replace-live-neo4j and a typed confirmation. The real scripts run against a stubbed docker
 * (fixtures/neo4j-docker.ts); nothing touches a database.
 */
import { spawn, spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { once } from 'events';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { gzipSync } from 'zlib';
import { NEO4J_DOCKER_STUB } from './fixtures/neo4j-docker';

const REPO = resolve(__dirname, '../../..');
// Generated per run so no fixed credential-shaped literal lives in the repo.
const PASSWORD = randomBytes(12).toString('hex');
const SCRIPTS = ['rollback.sh', 'backup-neo4j.sh', 'restore-neo4j.sh', 'neo4j-offline.sh'];

describe('HAP-1748: Neo4j backup and restore share one file and fail closed', () => {
  let dir: string;
  const stub = (name: string, lines: string[]) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${lines.join('\n')}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  const script = (name: string) => join(dir, 'root/infrastructure/scripts', name);
  const backup = () => join(dir, 'backups/T1/neo4j-backup.dump.gz');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hap1748-'));
    stub('docker', NEO4J_DOCKER_STUB);
    for (const name of ['sleep', 'curl']) stub(name, [':']);
    // api-server is running; every compose call lands in the same ordered log as docker's.
    stub('docker-compose', ['echo "compose $*" >> "$OUT.calls"', 'case "$*" in *"ps --services"*) echo api-server;; esac', 'exit 0']);
    mkdirSync(join(dir, 'root/infrastructure/scripts'), { recursive: true });
    for (const name of SCRIPTS) {
      if (existsSync(join(REPO, 'infrastructure/scripts', name))) copyFileSync(join(REPO, 'infrastructure/scripts', name), script(name));
    }
    mkdirSync(join(dir, 'backups/T1'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const env = (extra: Record<string, string> = {}) => ({
    PATH: `${dir}:/usr/bin:/bin`, OUT: join(dir, 'out'), TMPDIR: dir, BACKUP_DIR: join(dir, 'backups'), NEO4J_PASSWORD: PASSWORD, ...extra,
  });
  const run = (args: string[], extra: Record<string, string> = {}, input = '') => {
    const result = spawnSync('bash', args, {
      env: env(extra),
      input,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const calls = existsSync(join(dir, 'out.calls')) ? readFileSync(join(dir, 'out.calls'), 'utf8').split('\n') : [];
    const stop = calls.indexOf('docker stop cmdb-neo4j');
    return {
      status: result.status,
      out: `${result.stdout}${result.stderr}`,
      calls,
      at: (re: RegExp) => calls.findIndex((line) => re.test(line)),
      // This run stopped the live container and started it again afterwards.
      restarted: stop >= 0 && calls.indexOf('docker start cmdb-neo4j', stop) > stop,
    };
  };
  const rollback = (flags: string, env: Record<string, string> = {}) =>
    // Under a pty, as an operator runs it.
    run(['-c', `script -qec 'bash ${script('rollback.sh')} T1 database-only ${flags}' /dev/null`], env, 'ROLLBACK\nREPLACE neo4j\n');

  it('backup-neo4j.sh --to writes the file the deploy names, with Neo4j stopped only for the dump, and restore --check accepts it', () => {
    const produced = run([script('backup-neo4j.sh'), '--to', backup()]);
    expect(produced.status).toBe(0);
    expect(existsSync(backup())).toBe(true);
    const order = [/^docker stop cmdb-neo4j$/, /^docker create .*--volumes-from cmdb-neo4j .*database dump neo4j/, /^docker start cmdb-neo4j$/].map(produced.at);
    expect(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2]).toBe(true);
    expect(run([script('restore-neo4j.sh'), '--file', backup(), '--check']).status).toBe(0);
  });

  it('rollback with --replace-live-neo4j stops api-server, restores that file over the live database after a pre-restore dump, and restarts Neo4j then api-server', () => {
    writeFileSync(backup(), gzipSync('dump'));
    const { status, out, at } = rollback('--replace-live-neo4j');
    expect(status).toBe(0);
    expect(out).toContain('Neo4j restored');
    const order = [/^compose .* stop api-server$/, /^docker stop cmdb-neo4j$/, /database dump neo4j/, /database load .*--overwrite-destination=true neo4j/, /^docker start cmdb-neo4j$/, /^compose .* start api-server$/].map(at);
    expect(order.every((i) => i >= 0) && order.every((i, n) => n === 0 || order[n - 1] < i)).toBe(true);
  });

  it('rollback without --replace-live-neo4j refuses when a Neo4j backup exists, before Neo4j is stopped or loaded', () => {
    writeFileSync(backup(), gzipSync('dump'));
    const { status, at } = rollback('');
    expect(status).not.toBe(0);
    expect(at(/^docker (stop|create)/)).toBe(-1);
  });

  it.each([
    ['the pre-restore dump fails: exit 1, nothing changed, Neo4j started again', { FAIL_DUMP: '1' }, 1, true],
    ['the load fails: exit 3, Neo4j left STOPPED with the command that loads the pre-restore dump', { FAIL_LOAD: '1' }, 3, false],
    ['the restored counts differ from the backup\'s: exit 4, loaded, with the command that puts the old database back', { NODES: '4' }, 4, true],
  ])('restore-neo4j.sh --replace-live: when %s', (_case, env, code, restarted) => {
    writeFileSync(backup(), gzipSync('dump'));
    writeFileSync(join(dir, 'backups/T1/neo4j-backup.counts'), '5 7\n');
    const pre = join(dir, 'pre.dump.gz');
    const result = run([script('restore-neo4j.sh'), '--file', backup(), '--replace-live', '--pre-restore-backup', pre], env);
    expect({ status: result.status, restarted: result.restarted }).toEqual({ status: code, restarted });
    if (code !== 3) return;
    expect(result.out).toContain('STOPPED');
    // The printed command loads the pre-restore dump into the stopped container and starts it.
    rmSync(join(dir, 'out.calls'));
    const back = run(['-c', result.out.split('\n').find((line) => line.includes('--replace-stopped --file'))!.split('): ')[1]], { NEO4J_DOWN: '1' });
    expect({ status: back.status, started: back.calls.includes('docker start cmdb-neo4j') }).toEqual({ status: 0, started: true });
  });

  it('restore-neo4j.sh --replace-live: a TERM during the load exits 3, leaves Neo4j STOPPED and prints the command that loads the pre-restore dump', async () => {
    writeFileSync(backup(), gzipSync('dump'));
    const pre = join(dir, 'pre.dump.gz');
    const child = spawn('bash', [script('restore-neo4j.sh'), '--file', backup(), '--replace-live', '--pre-restore-backup', pre], { env: env({ BLOCK_LOAD: '1' }) });
    // The stub prints LOAD BLOCKED once the load container runs, then blocks until it is killed.
    let out = '';
    const blocked = Promise.withResolvers<void>();
    const collect = (data: Buffer) => {
      out += data;
      if (out.includes('LOAD BLOCKED')) blocked.resolve();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const closed = once(child, 'close');
    await blocked.promise;
    child.kill('SIGTERM');
    const [status] = await closed;
    const calls = readFileSync(join(dir, 'out.calls'), 'utf8').split('\n');
    expect({ status, stopped: calls.includes('docker stop cmdb-neo4j'), started: calls.includes('docker start cmdb-neo4j') }).toEqual({ status: 3, stopped: true, started: false });
    expect(out).toContain(`--replace-stopped --file ${pre}`);
  });

  it.each([
    ['backup-neo4j.sh --to', () => [script('backup-neo4j.sh'), '--to', join(dir, 'backups/T1/new.dump.gz')]],
    ['restore-neo4j.sh --replace-live', () => [script('restore-neo4j.sh'), '--file', backup(), '--replace-live', '--pre-restore-backup', join(dir, 'pre.dump.gz')]],
  ])('%s refuses a NEO4J_PASSWORD the running Neo4j rejects, before Neo4j is stopped', (_name, args) => {
    writeFileSync(backup(), gzipSync('dump'));
    const result = run(args(), { AUTH_FAIL: '1' });
    expect({ status: result.status, stopped: result.at(/^docker stop /) >= 0 }).toEqual({ status: 1, stopped: false });
  });

  it.each([
    ['the dump fails: no file, Neo4j started again', { FAIL_DUMP: '1' }, false, 'started again'],
    ['Neo4j cannot be started again: the dump is kept, and the output says STOPPED and how to start it', { FAIL_START: '1' }, true, 'STOPPED: starting it again failed. Start it: docker start cmdb-neo4j'],
  ])('backup-neo4j.sh --to: when %s', (_case, env, written, message) => {
    const result = run([script('backup-neo4j.sh'), '--to', backup()], env);
    expect({ status: result.status, written: existsSync(backup()), restarted: result.restarted }).toEqual({ status: 1, written, restarted: true });
    expect(result.out).toContain(message);
  });

  it('the daily backup-neo4j.sh run refuses without BACKUP_NEO4J_OFFLINE=true and never calls docker', () => {
    const result = run([script('backup-neo4j.sh')]);
    expect({ status: result.status, docker: result.calls.filter(Boolean) }).toEqual({ status: 1, docker: [] });
  });
});
