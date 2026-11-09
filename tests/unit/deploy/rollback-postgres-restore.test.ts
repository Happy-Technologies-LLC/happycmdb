/**
 * HAP-1749: rollback.sh hands restore-postgres.sh the backup via --file (a bare path hits usage(),
 * which exits 0) and never drops or loads over a live database: --drop is never passed, and an
 * exported RESTORE_DROP_DATABASE / RESTORE_CREATE_DATABASE is overridden, so CREATE DATABASE fails
 * on an existing database before any load. A failed restore ends the rollback non-zero without
 * claiming "PostgreSQL restored" and says Neo4j was already restored. The real rollback and restore
 * scripts run against stubbed docker and psql (the HAP-1668 harness); nothing touches a database.
 */
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO = resolve(__dirname, '../../..');
// Generated per run so no fixed credential-shaped literal lives in the repo.
const PASSWORD = randomBytes(12).toString('hex');
const DUMP = 'CREATE TABLE configuration_items (id integer);\n';

describe('HAP-1749: rollback.sh restores PostgreSQL via --file, never over a live database, and fails closed', () => {
  let dir: string;
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hap1749-'));
    stub('docker', '[ "$1" = ps ] && echo cmdb-neo4j\nexit 0');
    // psql: record every call; the connection check fails with PG_DOWN, CREATE DATABASE fails with
    // DB_EXISTS (as on a live server); the load (no -c) captures the SQL it was fed.
    stub('psql', [
      'echo "$*" >> "$OUT.calls"',
      'case "$*" in',
      '  *"SELECT 1"*) [ -z "$PG_DOWN" ] || exit 2;;',
      '  *"CREATE DATABASE"*) [ -z "$DB_EXISTS" ] || exit 1;;',
      '  *" -c "*) ;;',
      '  *) cat >> "$OUT.load"; echo "COPY 1";;',
      'esac',
    ].join('\n'));
    stub('docker-compose', ':');
    stub('sleep', ':');
    stub('curl', ':');
    const scripts = join(dir, 'root/infrastructure/scripts');
    mkdirSync(scripts, { recursive: true });
    for (const script of ['rollback.sh', 'restore-neo4j.sh', 'restore-postgres.sh']) {
      copyFileSync(join(REPO, 'infrastructure/scripts', script), join(scripts, script));
    }
    mkdirSync(join(dir, 'backups/T1'), { recursive: true });
    writeFileSync(join(dir, 'dump'), 'dump');
    expect(spawnSync('tar', ['-czf', join(dir, 'backups/T1/neo4j-backup.tar.gz'), '-C', dir, 'dump']).status).toBe(0);
    writeFileSync(join(dir, 'backups/T1/postgres-backup.sql'), DUMP);
    expect(spawnSync('gzip', [join(dir, 'backups/T1/postgres-backup.sql')]).status).toBe(0);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const rollback = (env: Record<string, string>) => {
    // Under a pty, as an operator runs it: a restore prompt after the typed ROLLBACK would meet EOF and cancel.
    const run = spawnSync('script', ['-qec', `bash ${join(dir, 'root/infrastructure/scripts/rollback.sh')} T1 database-only`, '/dev/null'], {
      env: {
        PATH: `${dir}:/usr/bin:/bin`, OUT: join(dir, 'out'), TMPDIR: dir, BACKUP_DIR: join(dir, 'backups'), NEO4J_PASSWORD: PASSWORD,
        // An operator's exported overrides must not turn the rollback into a drop or a load over the live database.
        RESTORE_DROP_DATABASE: 'true', RESTORE_CREATE_DATABASE: 'false', ...env,
      },
      input: 'ROLLBACK\n',
      encoding: 'utf8',
      timeout: 60_000,
    });
    const calls = existsSync(join(dir, 'out.calls')) ? readFileSync(join(dir, 'out.calls'), 'utf8') : '';
    const errorNames = (file: string) => run.stdout.split('\n').some((line) => line.includes('✗') && line.includes(join(dir, 'backups/T1', file)));
    return {
      exitedZero: run.status === 0,
      created: /CREATE DATABASE/.test(calls),
      loaded: existsSync(join(dir, 'out.load')) && readFileSync(join(dir, 'out.load'), 'utf8') === DUMP,
      dropped: /DROP DATABASE|pg_terminate_backend/.test(calls),
      claimedRestored: run.stdout.includes('PostgreSQL restored'),
      errorNamesBackup: errorNames('postgres-backup.sql.gz'),
      saysNeo4jAlreadyRestored: errorNames('neo4j-backup.tar.gz'),
    };
  };

  it('when the target database does not exist, it is created and the backup loaded without dropping anything', () => {
    expect(rollback({})).toEqual({
      exitedZero: true, created: true, loaded: true, dropped: false,
      claimedRestored: true, errorNamesBackup: false, saysNeo4jAlreadyRestored: false,
    });
  });

  it.each([
    ['the database already exists (live server)', { DB_EXISTS: '1' }],
    ['the server is unreachable', { PG_DOWN: '1' }],
  ])('when %s the rollback exits non-zero, loads nothing, names the backup and the restored Neo4j, never claims success', (_case, env) => {
    expect(rollback(env)).toMatchObject({
      exitedZero: false, loaded: false, dropped: false,
      claimedRestored: false, errorNamesBackup: true, saysNeo4jAlreadyRestored: true,
    });
  });
});
