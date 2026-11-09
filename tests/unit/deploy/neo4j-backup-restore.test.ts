/**
 * HAP-1748: the Neo4j backup the deploy writes is the one the rollback restores. backup-neo4j.sh --to FILE dumps the
 * stopped Community DBMS into FILE, restore-neo4j.sh --check verifies it, and rollback.sh restores it over the live
 * database only with --replace-live-neo4j and a typed confirmation. The real scripts run against a stubbed docker
 * (fixtures/neo4j-docker.ts); nothing touches a database.
 */
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
    for (const name of ['docker-compose', 'sleep', 'curl']) stub(name, [':']);
    mkdirSync(join(dir, 'root/infrastructure/scripts'), { recursive: true });
    for (const name of SCRIPTS) {
      if (existsSync(join(REPO, 'infrastructure/scripts', name))) copyFileSync(join(REPO, 'infrastructure/scripts', name), script(name));
    }
    mkdirSync(join(dir, 'backups/T1'), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[], env: Record<string, string> = {}, input = '') => {
    const result = spawnSync('bash', args, {
      env: { PATH: `${dir}:/usr/bin:/bin`, OUT: join(dir, 'out'), TMPDIR: dir, BACKUP_DIR: join(dir, 'backups'), NEO4J_PASSWORD: PASSWORD, ...env },
      input,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const calls = existsSync(join(dir, 'out.calls')) ? readFileSync(join(dir, 'out.calls'), 'utf8').split('\n') : [];
    return { status: result.status, out: `${result.stdout}${result.stderr}`, calls, at: (re: RegExp) => calls.findIndex((line) => re.test(line)) };
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

  it('rollback with --replace-live-neo4j restores that file over the live database after a pre-restore dump, and restarts Neo4j', () => {
    writeFileSync(backup(), gzipSync('dump'));
    const { status, out, at } = rollback('--replace-live-neo4j');
    expect(status).toBe(0);
    expect(out).toContain('Neo4j restored');
    const order = [/^docker stop cmdb-neo4j$/, /database dump neo4j/, /database load .*--overwrite-destination=true neo4j/, /^docker start cmdb-neo4j$/].map(at);
    expect(order.every((i) => i >= 0) && order.every((i, n) => n === 0 || order[n - 1] < i)).toBe(true);
  });
});
