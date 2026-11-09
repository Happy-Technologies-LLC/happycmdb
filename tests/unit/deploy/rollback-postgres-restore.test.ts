/**
 * HAP-1749 / HAP-1762: rollback.sh hands restore-postgres.sh the backup via --file and never drops a live database
 * unless the operator passes --replace-live-postgres AND types the REPLACE confirmation (no environment variable enables
 * it). With the opt-in, a preflight (no other client on the database, a pre-restore backup taken and verified) runs
 * before Neo4j is touched; then DROP, CREATE, an ON_ERROR_STOP single-transaction load and a per-table row-count check.
 * Any failure ends the rollback non-zero without claiming "PostgreSQL restored"; after the drop it names the pre-restore
 * backup and leaves the API stopped. The real rollback and restore scripts run against stubbed docker, docker-compose,
 * psql and pg_dump (the HAP-1668 harness); nothing touches a database.
 */
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const REPO = resolve(__dirname, '../../..');
// Generated per run so no fixed credential-shaped literal lives in the repo.
const PASSWORD = randomBytes(12).toString('hex');
const TRAILER = '--\n-- PostgreSQL database dump complete\n--\n\n';
const DUMP = `CREATE TABLE public.configuration_items (id integer);\nCOPY public.configuration_items (id) FROM stdin;\n1\n2\n\\.\n\n${TRAILER}`;

describe('HAP-1749/HAP-1762: rollback.sh PostgreSQL restore, guarded over a live database', () => {
  let dir: string;
  const stub = (name: string, lines: string[]) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${lines.join('\n')}\n`);
    chmodSync(join(dir, name), 0o755);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hap1762-'));
    // Every call lands in one ordered log. `docker cp` is restore-neo4j.sh loading the Neo4j dump.
    stub('docker', ['echo "docker $*" >> "$OUT.calls"', '[ "$1" = ps ] && echo cmdb-neo4j', 'exit 0']);
    stub('docker-compose', ['echo "compose $*" >> "$OUT.calls"', 'case "$*" in *"ps --services"*) echo api-server;; esac', 'exit 0']);
    stub('pg_dump', ['[ -z "$PGDUMP_FAIL" ] || exit 1', 'echo "pg_dump $*" >> "$OUT.calls"', `printf -- '-- live\\n${TRAILER.replace(/\n/g, '\\n')}'`]);
    // psql: DB_EXISTS = a live database (CREATE fails until it is dropped); CLIENT = another session on it; the load
    // (no -c) reads the SQL from stdin and fails with LOAD_FAIL; COUNT_MISMATCH makes the table hold 1 row, not 2.
    stub('psql', [
      'echo "psql $*" >> "$OUT.calls"',
      'case "$*" in',
      '  *pg_database*) [ -z "$DB_EXISTS" ] || echo 1;;',
      '  *pg_stat_activity*) [ -z "$CLIENT" ] || echo "cmdb_user api-server 172.18.0.5";;',
      '  *"SELECT 1"*) [ -z "$PG_DOWN" ] || exit 2;;',
      '  *"DROP DATABASE"*) : > "$OUT.dropped";;',
      '  *"CREATE DATABASE"*) [ -z "$DB_EXISTS" ] || [ -e "$OUT.dropped" ] || exit 1;;',
      '  *"FROM ONLY"*) if [ -n "$COUNT_MISMATCH" ]; then echo 1; else echo 2; fi;;',
      '  *" -c "*) ;;',
      '  *) cat >> "$OUT.load"; echo "LOAD $*" >> "$OUT.calls"; echo "COPY 2"; [ -z "$LOAD_FAIL" ] || exit 3;;',
      'esac',
    ]);
    stub('sleep', [':']);
    stub('curl', [':']);
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

  const rollback = (env: Record<string, string>, optIn: boolean) => {
    const args = `T1 database-only${optIn ? ' --replace-live-postgres' : ''}`;
    // Under a pty, as an operator runs it; the typed REPLACE confirmation is supplied even without the flag.
    const run = spawnSync('script', ['-qec', `bash ${join(dir, 'root/infrastructure/scripts/rollback.sh')} ${args}`, '/dev/null'], {
      env: {
        PATH: `${dir}:/usr/bin:/bin`, OUT: join(dir, 'out'), TMPDIR: dir, BACKUP_DIR: join(dir, 'backups'), NEO4J_PASSWORD: PASSWORD,
        // Exported overrides must not turn the rollback into a drop or a load over the live database.
        RESTORE_DROP_DATABASE: 'true', RESTORE_CREATE_DATABASE: 'false', ...env,
      },
      input: 'ROLLBACK\nREPLACE cmdb\n',
      encoding: 'utf8',
      timeout: 60_000,
    });
    const calls = existsSync(join(dir, 'out.calls')) ? readFileSync(join(dir, 'out.calls'), 'utf8').split('\n') : [];
    const at = (re: RegExp) => calls.findIndex((line) => re.test(line));
    const errorNames = (file: string) => run.stdout.split('\n').some((line) => line.includes('✗') && line.includes(file));
    const snapshot = readdirSync(join(dir, 'backups')).find((name) => name.startsWith('safety-snapshot-'));
    const preBackup = snapshot ? join(dir, 'backups', snapshot, 'postgres-pre-restore-cmdb.sql.gz') : '';
    return {
      run,
      at,
      preBackup,
      result: {
        exitedZero: run.status === 0,
        preBackupTaken: at(/^pg_dump /) >= 0,
        neo4jRestored: at(/^docker cp /) >= 0,
        dropped: at(/^psql .*(DROP DATABASE|pg_terminate_backend)/) >= 0,
        loaded: existsSync(join(dir, 'out.load')) && readFileSync(join(dir, 'out.load'), 'utf8') === DUMP,
        apiRestarted: at(/^compose .* start api-server/) >= 0,
        claimedRestored: run.stdout.includes('PostgreSQL restored'),
      },
      errorNamesBackup: errorNames(join(dir, 'backups/T1/postgres-backup.sql.gz')),
      errorNamesPreBackup: errorNames('postgres-pre-restore-cmdb.sql.gz'),
    };
  };

  it('when the target database does not exist, it is created and loaded without the opt-in, a drop or a pre-restore backup', () => {
    expect(rollback({}, false).result).toEqual({
      exitedZero: true, preBackupTaken: false, neo4jRestored: true, dropped: false, loaded: true, apiRestarted: false, claimedRestored: true,
    });
  });

  it.each([
    ['the database exists and the opt-in flag is missing (typed confirmation and RESTORE_* exports present)', { DB_EXISTS: '1' }],
    ['the server is unreachable', { PG_DOWN: '1' }],
  ])('when %s it refuses before Neo4j is touched and drops nothing', (_case, env) => {
    const { result, errorNamesBackup } = rollback(env, false);
    expect(result).toMatchObject({ exitedZero: false, preBackupTaken: false, neo4jRestored: false, dropped: false, loaded: false, claimedRestored: false });
    expect(errorNamesBackup).toBe(true);
  });

  it('with the opt-in it stops the API, backs up, restores Neo4j, then drops, recreates, loads with ON_ERROR_STOP in one transaction, verifies and restarts the API', () => {
    const { result, at, preBackup } = rollback({ DB_EXISTS: '1' }, true);
    expect(result).toEqual({
      exitedZero: true, preBackupTaken: true, neo4jRestored: true, dropped: true, loaded: true, apiRestarted: true, claimedRestored: true,
    });
    const order = [/stop api-server/, /^pg_dump /, /^docker cp /, /^psql .*DROP DATABASE/, /^psql .*CREATE DATABASE/, /^LOAD /, /FROM ONLY public\.configuration_items/, /start api-server/].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(at(/^LOAD .*ON_ERROR_STOP=1.*--single-transaction/)).toBeGreaterThanOrEqual(0);
    expect(spawnSync('gunzip', ['-c', preBackup], { encoding: 'utf8' }).stdout.endsWith(TRAILER)).toBe(true);
  });

  it.each([
    ['the pre-restore backup fails', { PGDUMP_FAIL: '1' }],
    ['another client is still connected', { CLIENT: '1' }],
  ])('with the opt-in, when %s it refuses before Neo4j and the drop, and restarts the API it stopped', (_case, env) => {
    expect(rollback({ DB_EXISTS: '1', ...env }, true).result).toEqual({
      exitedZero: false, preBackupTaken: false, neo4jRestored: false, dropped: false, loaded: false, apiRestarted: true, claimedRestored: false,
    });
  });

  it.each([
    ['the load fails', { LOAD_FAIL: '1' }],
    ['the restored row counts do not match the backup', { COUNT_MISMATCH: '1' }],
  ])('with the opt-in, when %s after the drop it exits non-zero, names the pre-restore backup and leaves the API stopped', (_case, env) => {
    const { result, errorNamesPreBackup } = rollback({ DB_EXISTS: '1', ...env }, true);
    expect(result).toMatchObject({ exitedZero: false, neo4jRestored: true, dropped: true, apiRestarted: false, claimedRestored: false });
    expect(errorNamesPreBackup).toBe(true);
  });
});
