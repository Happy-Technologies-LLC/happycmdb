/**
 * HAP-1668: rollback.sh hands restore-neo4j.sh the backup via --file (never --force, which
 * drops the live database before the load) and fails closed: a failed restore ends the rollback
 * non-zero without claiming "Neo4j restored". The real rollback and restore scripts run against
 * a stubbed docker (the HAP-1647 harness); nothing touches a real database.
 */
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO = resolve(__dirname, '../../..');
// Generated per run so no fixed credential-shaped literal lives in the repo.
const PASSWORD = randomBytes(12).toString('hex');

describe('HAP-1668: rollback.sh restores Neo4j via --file and fails closed', () => {
  let dir: string;
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hap1668-'));
    // docker: record every call; cmdb-neo4j runs; the dump load fails when FAIL_LOAD is set.
    stub('docker', 'echo "$*" >> "$OUT.calls"\n[ "$1" = ps ] && echo cmdb-neo4j\ncase "$*" in *neo4j-admin*) [ -z "$FAIL_LOAD" ] || exit 1;; esac\nexit 0');
    stub('docker-compose', ':');
    stub('sleep', ':');
    stub('curl', ':');
    const scripts = join(dir, 'root/infrastructure/scripts');
    mkdirSync(scripts, { recursive: true });
    for (const script of ['rollback.sh', 'restore-neo4j.sh']) {
      copyFileSync(join(REPO, 'infrastructure/scripts', script), join(scripts, script));
    }
    mkdirSync(join(dir, 'backups/T1'), { recursive: true });
    writeFileSync(join(dir, 'dump'), 'dump');
    expect(spawnSync('tar', ['-czf', join(dir, 'backups/T1/neo4j-backup.tar.gz'), '-C', dir, 'dump']).status).toBe(0);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const rollback = (env: Record<string, string>) => {
    // Under a pty (util-linux script), as an operator runs it: stdin is a terminal, so any
    // prompt the restore raises after the typed ROLLBACK would meet EOF and cancel it.
    const run = spawnSync('script', ['-qec', `bash ${join(dir, 'root/infrastructure/scripts/rollback.sh')} T1 database-only`, '/dev/null'], {
      env: { PATH: `${dir}:/usr/bin:/bin`, OUT: join(dir, 'out'), TMPDIR: dir, BACKUP_DIR: join(dir, 'backups'), ...env },
      input: 'ROLLBACK\n',
      encoding: 'utf8',
      timeout: 60_000,
    });
    const calls = existsSync(join(dir, 'out.calls')) ? readFileSync(join(dir, 'out.calls'), 'utf8') : '';
    const backup = join(dir, 'backups/T1/neo4j-backup.tar.gz');
    return {
      exitedZero: run.status === 0,
      loadRan: /exec cmdb-neo4j neo4j-admin database load/.test(calls),
      // --force means DROP DATABASE plus an overwriting load.
      forced: /DROP DATABASE|--overwrite-destination/.test(calls),
      claimedRestored: run.stdout.includes('Neo4j restored'),
      errorNamesBackup: run.stdout.split('\n').some((line) => line.includes('✗') && line.includes(backup)),
    };
  };

  it('with NEO4J_PASSWORD set and a good load, the dump is loaded without forcing (even with RESTORE_FORCE exported)', () => {
    expect(rollback({ NEO4J_PASSWORD: PASSWORD, RESTORE_FORCE: 'true' })).toEqual({
      exitedZero: true, loadRan: true, forced: false, claimedRestored: true, errorNamesBackup: false,
    });
  });

  it.each([
    ['NEO4J_PASSWORD is unset', {}],
    ['the dump load fails', { NEO4J_PASSWORD: PASSWORD, FAIL_LOAD: '1' }],
  ])('when %s the rollback exits non-zero, names the backup and never claims Neo4j restored', (_case, env) => {
    expect(rollback(env)).toMatchObject({ exitedZero: false, forced: false, claimedRestored: false, errorNamesBackup: true });
  });
});
