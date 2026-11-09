/**
 * HAP-1749 / HAP-1762: rollback.sh hands restore-postgres.sh the backup via --file and never drops a live database
 * unless the operator passes --replace-live-postgres AND types the REPLACE confirmation (no environment variable enables
 * it). With the opt-in, a preflight (no other client on the database, a pre-restore backup taken and verified) runs
 * before Neo4j is touched; then DROP, CREATE, an ON_ERROR_STOP single-transaction load and a per-table row-count check.
 * Any failure ends the rollback non-zero; after the drop the API stays stopped and restore-postgres.sh exits 3 (dropped,
 * not loaded) or 4 (loaded, counts differ). The real rollback and restore scripts run against stubbed docker,
 * docker-compose, git, npm, psql and pg_dump (the HAP-1668 harness); nothing touches a database.
 */
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { gzipSync } from 'zlib';
import { NEO4J_DOCKER_STUB } from './fixtures/neo4j-docker';

const REPO = resolve(__dirname, '../../..');
const NEO4J_LOAD = /^docker create .* database load --from-path/;
// Generated per run so no fixed credential-shaped literal lives in the repo.
const PASSWORD = randomBytes(12).toString('hex');
// pg_dump before 13.22/14.19/15.14/16.10/17.6 ends at the completion line; later ones add a \unrestrict line after it.
const LEGACY = { head: '', trailer: '--\n-- PostgreSQL database dump complete\n--\n\n' };
const MODERN = { head: '\\restrict k3y\n', trailer: `${LEGACY.trailer}\\unrestrict k3y\n\n` };
const dumpOf = (kind: typeof LEGACY) =>
  `${kind.head}CREATE TABLE public.configuration_items (id integer);\nCOPY public.configuration_items (id) FROM stdin;\n1\n2\n\\.\n\n${kind.trailer}`;

describe('HAP-1749/HAP-1762: rollback.sh PostgreSQL restore, guarded over a live database', () => {
  let dir: string;
  const stub = (name: string, lines: string[]) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${lines.join('\n')}\n`);
    chmodSync(join(dir, name), 0o755);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hap1762-'));
    // Every call lands in one ordered log. A one-off `database load --from-path` container is restore-neo4j.sh loading
    // the Neo4j dump (HAP-1748).
    stub('docker', NEO4J_DOCKER_STUB);
    stub('docker-compose', ['echo "compose $*" >> "$OUT.calls"', 'case "$*" in *"ps --services"*) echo api-server;; esac', 'exit 0']);
    stub('pg_dump', [
      '[ -z "$PGDUMP_FAIL" ] || exit 1',
      'echo "pg_dump $*" >> "$OUT.calls"',
      "printf '%s\\n' '-- live' '--' '-- PostgreSQL database dump complete' '--' ''",
      "[ -z \"$MODERN\" ] || printf '%s\\n' '\\unrestrict k3y' ''",
    ]);
    // psql: DB_EXISTS = a live database (CREATE fails until it is dropped); CLIENT = another session on it; the load
    // (no -c) reads the SQL from stdin and fails with LOAD_FAIL; COUNT_MISMATCH makes the table hold 1 row, not 2.
    stub('psql', [
      'echo "psql $*" >> "$OUT.calls"',
      'case "$*" in',
      '  --version) echo "psql (PostgreSQL) ${PSQL_VERSION:-16.15}";;',
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
    for (const name of ['sleep', 'curl', 'npm']) stub(name, [':']);
    // A full rollback's `git checkout` puts back a restore-postgres.sh that predates every HAP-1762 flag: unknown options
    // reach usage(), which exits 0 without restoring anything.
    stub('git', ['[ "$1" = checkout ] || exit 0', "printf '#!/bin/bash\\necho \"Usage: restore-postgres.sh\"\\nexit 0\\n' > infrastructure/scripts/restore-postgres.sh"]);
    const scripts = join(dir, 'root/infrastructure/scripts');
    mkdirSync(scripts, { recursive: true });
    for (const script of ['rollback.sh', 'restore-neo4j.sh', 'neo4j-offline.sh', 'restore-postgres.sh']) {
      copyFileSync(join(REPO, 'infrastructure/scripts', script), join(scripts, script));
    }
    mkdirSync(join(dir, 'backups/T1'), { recursive: true });
    writeFileSync(join(dir, 'backups/T1/neo4j-backup.dump.gz'), gzipSync('dump'));
    writeFileSync(join(dir, 'backups/T1/git-commit.txt'), '3ecb885\n');
    writeBackup(LEGACY);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const writeBackup = (kind: typeof LEGACY) => {
    writeFileSync(join(dir, 'backups/T1/postgres-backup.sql'), dumpOf(kind));
    expect(spawnSync('gzip', ['-f', join(dir, 'backups/T1/postgres-backup.sql')]).status).toBe(0);
  };
  const stubEnv = (env: Record<string, string>) => ({
    PATH: `${dir}:/usr/bin:/bin`, OUT: join(dir, 'out'), TMPDIR: dir, BACKUP_DIR: join(dir, 'backups'), NEO4J_PASSWORD: PASSWORD,
    // Exported overrides must not turn a restore into a drop or a load over the live database.
    RESTORE_DROP_DATABASE: 'true', RESTORE_CREATE_DATABASE: 'false', ...env,
  });

  // restore-postgres.sh run on its own, stdin detached: its exit code is the state contract (1 / 3 / 4).
  const restore = (env: Record<string, string>, preBackup: string) => {
    const run = spawnSync('bash', [join(dir, 'root/infrastructure/scripts/restore-postgres.sh'), '--replace-live', '--verify',
      '--file', join(dir, 'backups/T1/postgres-backup.sql.gz'), '--pre-restore-backup', preBackup], {
      env: stubEnv({ POSTGRES_PASSWORD: PASSWORD, ...env, OUT: join(dir, 'solo') }), input: '', encoding: 'utf8', timeout: 60_000,
    });
    const calls = existsSync(join(dir, 'solo.calls')) ? readFileSync(join(dir, 'solo.calls'), 'utf8') : '';
    return { status: run.status, dropped: /^psql .*DROP DATABASE/m.test(calls), out: run.stdout };
  };

  const rollback = (env: Record<string, string>, optIn: boolean, mode = 'database-only', kind = LEGACY) => {
    const args = `T1 ${mode}${optIn ? ' --replace-live-postgres' : ''} --replace-live-neo4j`;
    // Under a pty, as an operator runs it; the typed REPLACE confirmation is supplied even without the flag.
    const run = spawnSync('script', ['-qec', `bash ${join(dir, 'root/infrastructure/scripts/rollback.sh')} ${args}`, '/dev/null'], {
      env: stubEnv(env),
      input: optIn ? 'ROLLBACK\nREPLACE cmdb\nREPLACE neo4j\n' : 'ROLLBACK\nREPLACE neo4j\nREPLACE cmdb\n',
      encoding: 'utf8',
      timeout: 60_000,
    });
    const calls = existsSync(join(dir, 'out.calls')) ? readFileSync(join(dir, 'out.calls'), 'utf8').split('\n') : [];
    const at = (re: RegExp) => calls.findIndex((line) => re.test(line));
    const snapshot = readdirSync(join(dir, 'backups')).find((name) => name.startsWith('safety-snapshot-'));
    const preBackup = snapshot ? join(dir, 'backups', snapshot, 'postgres-pre-restore-cmdb.sql.gz') : '';
    return {
      run,
      at,
      preBackup,
      result: {
        exitedZero: run.status === 0,
        preBackupTaken: at(/^pg_dump /) >= 0,
        neo4jRestored: at(NEO4J_LOAD) >= 0,
        dropped: at(/^psql .*(DROP DATABASE|pg_terminate_backend)/) >= 0,
        loaded: existsSync(join(dir, 'out.load')) && readFileSync(join(dir, 'out.load'), 'utf8') === dumpOf(kind),
        apiRestarted: at(/^compose .* start api-server/) >= 0,
      },
    };
  };

  it('when the target database does not exist, it is created and loaded without the opt-in, a drop or a pre-restore backup', () => {
    // api-server is stopped and restarted for the Neo4j replace (--replace-live-neo4j, HAP-1748), not for PostgreSQL.
    expect(rollback({}, false).result).toEqual({
      exitedZero: true, preBackupTaken: false, neo4jRestored: true, dropped: false, loaded: true, apiRestarted: true,
    });
  });

  it('a full rollback restores PostgreSQL with the restore script it started with, not the one git checkout put back', () => {
    expect(rollback({}, false, 'full').result).toMatchObject({ exitedZero: true, neo4jRestored: true, dropped: false, loaded: true });
  });

  it.each([
    ['the database exists and the opt-in flag is missing (typed confirmation and RESTORE_* exports present)', { DB_EXISTS: '1' }],
    ['the server is unreachable', { PG_DOWN: '1' }],
  ])('when %s it refuses before Neo4j is touched and drops nothing', (_case, env) => {
    expect(rollback(env, false).result).toMatchObject({ exitedZero: false, preBackupTaken: false, neo4jRestored: false, dropped: false, loaded: false });
  });

  it.each([
    ['a dump ending at the completion line', LEGACY, {}],
    ['a pg_dump 16.10+ dump ending in \\unrestrict', MODERN, { MODERN: '1' }],
  ])('with the opt-in and %s it stops the API, backs up, restores Neo4j, then drops, recreates, loads with ON_ERROR_STOP in one transaction, verifies and restarts the API', (_case, kind, env) => {
    writeBackup(kind);
    const { result, at, preBackup } = rollback({ DB_EXISTS: '1', ...env }, true, 'database-only', kind);
    expect(result).toEqual({
      exitedZero: true, preBackupTaken: true, neo4jRestored: true, dropped: true, loaded: true, apiRestarted: true,
    });
    const order = [/stop api-server/, /^pg_dump /, NEO4J_LOAD, /^psql .*DROP DATABASE/, /^psql .*CREATE DATABASE/, /^LOAD /, /FROM ONLY public\.configuration_items/, /start api-server/].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(at(/^LOAD .*ON_ERROR_STOP=1.*--single-transaction/)).toBeGreaterThanOrEqual(0);
    expect(spawnSync('gunzip', ['-c', preBackup], { encoding: 'utf8' }).stdout.endsWith(kind.trailer)).toBe(true);
  });

  it.each([
    ['the pre-restore backup fails', { PGDUMP_FAIL: '1' }],
    ['another client is still connected', { CLIENT: '1' }],
  ])('with the opt-in, when %s it refuses before Neo4j and the drop, and restarts the API it stopped', (_case, env) => {
    expect(rollback({ DB_EXISTS: '1', ...env }, true).result).toEqual({
      exitedZero: false, preBackupTaken: false, neo4jRestored: false, dropped: false, loaded: false, apiRestarted: true,
    });
  });

  it('an existing --pre-restore-backup file is never taken as the copy of the live database: exit 1, nothing dropped', () => {
    const stale = join(dir, 'stale.sql.gz');
    copyFileSync(join(dir, 'backups/T1/postgres-backup.sql.gz'), stale);
    expect(restore({ DB_EXISTS: '1' }, stale)).toMatchObject({ status: 1, dropped: false });
  });

  it.each([
    ['older than', '15.4', { status: 1, dropped: false }],
    ['as new as', '16.15', { status: 0, dropped: true }],
  ])('a local psql %s (%s) the pg_dump 16.15 that wrote the backup: refused before the drop, or restored', (_case, version, expected) => {
    writeBackup({ ...MODERN, head: `-- Dumped by pg_dump version 16.15\n${MODERN.head}` });
    expect(restore({ DB_EXISTS: '1', PSQL_VERSION: version }, join(dir, 'ver-pre.sql.gz'))).toMatchObject(expected);
  });

  it.each([
    ['the load fails', 3, { LOAD_FAIL: '1' }],
    ['the restored row counts do not match the backup', 4, { COUNT_MISMATCH: '1' }],
  ])('with the opt-in, when %s after the drop the rollback fails with the API left stopped and the restore exits %d', (_case, code, env) => {
    const { result, at } = rollback({ DB_EXISTS: '1', ...env }, true);
    expect(result).toMatchObject({ exitedZero: false, neo4jRestored: true, dropped: true, apiRestarted: false });
    expect(at(NEO4J_LOAD)).toBeLessThan(at(/^psql .*DROP DATABASE/));
    expect(restore({ DB_EXISTS: '1', ...env }, join(dir, 'solo-pre.sql.gz'))).toMatchObject({ status: code, dropped: true });
  });

  // The block the restore prints, run as printed with bash, against a psql that fails for one named migration file.
  it.each([
    ['every file succeeds', '', ['032', '033', '039', '044', '045', '046', '047', '048']],
    ['033 fails', '033_public_business_service_audit_acl.sql', ['032', '033']],
  ])('the printed grant step revokes PUBLIC EXECUTE first and stops non-zero, naming the file, when %s', (_case, failFile, files) => {
    const { status, out } = restore({ DB_EXISTS: '1' }, join(dir, 'grant-pre.sql.gz'));
    expect(status).toBe(0);
    writeFileSync(join(dir, 'grant-step.sh'), out.slice(out.lastIndexOf('\n', out.indexOf('MANDATORY POST-RESTORE GRANT STEP')) + 1));
    const ledger = ['032_secret_table_public_grants', '033_public_business_service_audit_acl', '034_history_sequence_discovery_acl',
      '039_recent_audit_activity_acl', '044_business_service_journal_read_acl', '045_staging_app_login_acl', '046_service_offerings',
      '047_ai_sync_cursors', '048_portfolio_import'].map((name) => `${name}.sql`);
    mkdirSync(join(dir, 'grant'));
    stub('grant/psql', [
      'echo "psql $*" >> "$OUT.calls"',
      `case "$*" in *schema_migrations*) printf '%s\\n' ${ledger.join(' ')}; exit 0;; esac`,
      'case "$*" in *"$FAIL_FILE"*) [ -z "$FAIL_FILE" ] || exit 3;; esac',
    ]);
    const run = spawnSync('bash', [join(dir, 'grant-step.sh')], {
      env: { PATH: `${join(dir, 'grant')}:/usr/bin:/bin`, OUT: join(dir, 'grant'), FAIL_FILE: failFile }, encoding: 'utf8', timeout: 60_000,
    });
    const calls = existsSync(join(dir, 'grant.calls')) ? readFileSync(join(dir, 'grant.calls'), 'utf8').split('\n') : [];
    expect(calls.flatMap((line) => line.match(/ -f \S*\/(\d{3})_\S*\.sql/)?.[1] ?? [])).toEqual(files);
    expect(calls.findIndex((line) => line.includes('REVOKE EXECUTE'))).toBeLessThan(calls.findIndex((line) => line.includes(' -f ')));
    expect(calls.findIndex((line) => line.includes('REVOKE EXECUTE'))).toBeGreaterThanOrEqual(0);
    // 032 grants metabase_readonly the cross-tenant view that 033 revokes: 032's own transaction takes it back.
    expect(calls.find((line) => line.includes('/032_'))).toMatch(/REVOKE SELECT ON public\.v_business_service_health\b.* FROM metabase_readonly/);
    expect(run.status === 0).toBe(failFile === '');
    expect(run.stderr).toContain(failFile);
  });
});
