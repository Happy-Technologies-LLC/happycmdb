// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-774 S5a: the legacy discovery-definition classifier runs against PGlite (the discovery_definitions and
 * credentials blocks of 001_complete_schema.sql, 024's organization column, 021's credential organization column and
 * the seed's provider-check drop). Every secret, name and target carries the S5ASENTINEL marker.
 */

import { fork, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inspect } from 'util';
import { Console } from 'console';

import type { PostgresClient } from '../../../../database/src/postgres/client';

import { EncryptionService, getEncryptionService } from '../../../../common/src/services/encryption.service';
import { logger } from '../../../../common/src/utils/logger';
import { exitAfterFlush, main, MAX_CONFIG_DEPTH, openPostgres, type SqlClient } from '../migrate-legacy-discovery-definitions';

const host = fork(join(__dirname, '../../rest/routes/__tests__/fixtures/pglite-host.cjs'), [], { serialization: 'advanced' });
let nextId = 0;
const pending = new Map<number, { resolve: (rows: unknown[]) => void; reject: (e: Error) => void }>();
host.on('message', ({ id, rows, error }: { id: number; rows: unknown[]; error?: string }) => {
  const p = pending.get(id)!;
  pending.delete(id);
  if (error === undefined) p.resolve(rows);
  else p.reject(new Error(error));
});
function send(op: 'exec' | 'query', sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const id = nextId++;
  const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
  pending.set(id, { resolve, reject });
  host.send({ id, op, sql, params });
  return promise as Promise<Array<Record<string, unknown>>>;
}
const queries: string[] = [];
const client: SqlClient = { query: async (sql, params) => (queries.push(sql), { rows: await send('query', sql, params) }), close: async () => undefined };

const KEY = 'S5ASENTINEL-TEST-KEY-0123456789abcdef';
const ENV = { CMDB_MIGRATION_POSTGRES_HOST: '127.0.0.1', CMDB_MIGRATION_POSTGRES_PORT: '5432', CMDB_MIGRATION_POSTGRES_DB: 'd', CMDB_MIGRATION_POSTGRES_USER: 'u', CMDB_MIGRATION_POSTGRES_PASSWORD: 'S5ASENTINEL-DBPW' };
const [ORG, ORG_B, OWNER] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 's5asentinel-owner'];
const [U, PW] = ['s5asentinel-user', 'S5ASENTINEL-PW-1'];
const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nS5ASENTINEL-KEY\n-----END OPENSSH PRIVATE KEY-----';
const H = (n: number) => `s5asentinel-h${n}.example`;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PASSWORD = { username: U, password: PW };
// Stored credentials for the L1d rows: [id, org, owner, protocol, decoded payload, stored value if not the test-key envelope].
const CREDENTIALS: Array<[number, string, string, string, object, unknown?]> = [
  [90, ORG, OWNER, 'ssh_password', PASSWORD], [91, ORG, OWNER, 'ssh_password', { ...PASSWORD, password: 'S5ASENTINEL-PW-2' }],
  [92, ORG, OWNER, 'ssh_key', PASSWORD], [93, ORG_B, OWNER, 'ssh_password', PASSWORD], [94, ORG, 's5asentinel-other', 'ssh_password', PASSWORD],
  [96, ORG, OWNER, 'ssh_password', { ...PASSWORD, extra: 'S5ASENTINEL-X' }],
  // Equal payloads whose decode fails (another key; a garbage envelope) or that is no envelope at all (C2 plaintext).
  [97, ORG, OWNER, 'ssh_password', PASSWORD, new EncryptionService('S5ASENTINEL-OTHER-KEY-0123456789abcdef').encrypt(JSON.stringify(PASSWORD))],
  [98, ORG, OWNER, 'ssh_password', PASSWORD, { iv: 'S5A98', encryptedData: 'S5ASENTINEL', authTag: 'S5A98' }],
  [99, ORG, OWNER, 'ssh_password', PASSWORD, PASSWORD],
];
const ENVELOPE_IDS = new Map<string, number>(); // envelope iv -> credential number, to see which ones were decoded
const ssh = (targets: string[], credentials: object = PASSWORD) => ({ targets, credentials });
const nested = (depth: number): unknown => (depth === 0 ? PW : { a: nested(depth - 1) });
// [fixture, provider, org, credential_id, credential_set_id, config, `shape disposition reason protocol`]
const FIXTURES: Array<[string, string, string | null, number | null, number | null, unknown, string]> = [
  ['L1 uniform port', 'ssh', ORG, null, null, ssh([`${H(1)}:2222`, `${H(2)}:2222`]), 'L1 CONVERT INLINE_CREDENTIAL ssh_password'],
  ['L1b PEM', 'ssh', ORG, null, null, ssh([H(1)], { username: U, privateKey: PEM }), 'L1 CONVERT INLINE_CREDENTIAL ssh_key'],
  ['L1 key path', 'ssh', ORG, null, null, ssh([H(1)], { username: U, privateKey: '/s5asentinel/id_rsa' }), 'L1 LEAVE PATH_REFERENCE'],
  ['L1 mixed ports', 'ssh', ORG, null, null, ssh([`${H(1)}:22`, `${H(2)}:2222`]), 'L1 LEAVE TARGET_GRAMMAR'],
  ['L1 IPv6 bracket', 'ssh', ORG, null, null, ssh(['[2001:db8::5a]:22']), 'L1 LEAVE TARGET_GRAMMAR'],
  ['L1d equal payload', 'ssh', ORG, 90, null, ssh([H(1)]), 'L1d STRIP_EQUAL PAYLOAD_EQUAL null'],
  ['L1d one char differs', 'ssh', ORG, 91, null, ssh([H(1)]), 'L1d LEAVE DUAL_CREDENTIAL_MISMATCH'],
  ['L1d C1 mislabeled ssh_key', 'ssh', ORG, 92, null, ssh([H(1)]), 'L1d LEAVE DUAL_CREDENTIAL_MISMATCH'],
  ['L1d other org', 'ssh', ORG, 93, null, ssh([H(1)]), 'L1d LEAVE DUAL_CREDENTIAL_MISMATCH'],
  ['L1d other owner', 'ssh', ORG, 94, null, ssh([H(1)]), 'L1d LEAVE DUAL_CREDENTIAL_MISMATCH'],
  ['L1d stored payload has an extra key', 'ssh', ORG, 96, null, ssh([H(1)]), 'L1d LEAVE DUAL_CREDENTIAL_MISMATCH'],
  ['L2 AD', 'active-directory', ORG, null, null, { domain: H(2), base_dn: 'dc=s5asentinel', use_ssl: true, users: { enabled: true }, credentials: PASSWORD }, 'L2 LEAVE UNSUPPORTED_PROVIDER'],
  ['L3 SNMP', 'snmp', ORG, null, null, { targets: [H(3)], version: '2c', credentials: { community: PW } }, 'L3 LEAVE UNSUPPORTED_PROVIDER'],
  ['L4 UI ports', 'nmap', ORG, null, null, { targets: [H(4)], scanOptions: { ports: '22,80', serviceDetection: true } }, 'L4 CONVERT BENIGN_STRIP'],
  ['L5 seed ssh', 'ssh', null, null, null, { targets: ['192.168.1.0/24'], port: 22, timeout: 30 }, 'L5 LEAVE NO_CREDENTIAL_MATERIAL'],
  ['L6 seed nmap', 'nmap', null, null, null, { targets: ['10.0.0.0/24'], ports: '1-1024', scan_type: 'syn' }, 'L6 LEAVE NO_VERIFIED_ORG'],
  ['L7 seed AD', 'activedirectory', null, null, null, { ldap_url: `ldap://${H(7)}`, base_dn: 'dc=s5asentinel', resources: ['users'] }, 'L7 LEAVE UNSUPPORTED_PROVIDER'],
  ['L8 cloud', 'aws', ORG, null, null, { regions: ['us-east-1'], credentials: { accessKeyId: 'AKIAS5ASENTINEL', secretAccessKey: PW } }, 'L8 LEAVE UNSUPPORTED_PROVIDER'],
  ['L9 alias', 'nmap', ORG, null, null, { _targets: [H(9)] }, 'L9 CONVERT ALIAS_RENAME'],
  ['L10 shared', 'ssh', ORG, null, null, { hosts: [{ host: H(1), ...PASSWORD }, { host: H(2), ...PASSWORD }] }, 'L10 CONVERT INLINE_CREDENTIAL ssh_password'],
  ['L10 heterogeneous', 'ssh', ORG, null, null, { hosts: [{ host: H(1), ...PASSWORD }, { host: H(2), username: U, password: 'S5ASENTINEL-PW-3' }] }, 'L10 LEAVE HETEROGENEOUS_CREDENTIALS'],
  ['L10 key path', 'ssh', ORG, null, null, { _config: { targets: [{ host: H(1), username: U, privateKeyPath: '/s5asentinel/k' }] } }, 'L10 LEAVE PATH_REFERENCE'],
  ['L11 ssh one credential', 'ssh', ORG, null, null, { targets: [`root:${PW}@${H(1)}`, `root:${PW}@${H(2)}`] }, 'L11 CONVERT INLINE_CREDENTIAL ssh_password'],
  ['L11 ssh two credentials', 'ssh', ORG, null, null, { targets: [`root:${PW}@${H(1)}`, `admin:${PW}@${H(2)}`] }, 'L11 LEAVE TARGET_SECRET'],
  ['L11 nmap', 'nmap', ORG, null, null, { range: `ssh://u:${PW}@${H(11)}` }, 'L11 LEAVE NMAP_SECRET_NO_CONSUMER'],
  ['L12 string JSONB', 'ssh', ORG, null, null, JSON.stringify(ssh([H(12)])), 'L12 LEAVE MALFORMED'],
  ['NULL org', 'ssh', null, null, null, ssh([H(1)]), 'L1 LEAVE NO_VERIFIED_ORG'],
  ['credential set', 'ssh', ORG, null, 95, ssh([H(1)]), 'L1 LEAVE CREDENTIAL_SET_UNSUPPORTED'],
  ['already safe', 'nmap', ORG, null, null, { targets: [H(13)] }, 'SAFE SKIP ALREADY_SAFE null'],
  ['unknown', 'ssh', ORG, null, null, { targets: [H(1)], token: PW }, 'UNKNOWN LEAVE UNRECOGNIZED null'],
  ['unlisted provider', 's5asentinel-provider', ORG, null, null, { token: PW }, 'L7 LEAVE UNSUPPORTED_PROVIDER null'],
  // L5 is "no secret" (§3.2): key names alone never prove it.
  ['ssh host objects in targets', 'ssh', ORG, null, null, { targets: [{ host: H(1), ...PASSWORD }] }, 'UNKNOWN LEAVE UNRECOGNIZED null'],
  ['ssh password object in targets', 'ssh', ORG, null, null, { targets: [{ password: PW }] }, 'UNKNOWN LEAVE UNRECOGNIZED null'],
  ['ssh secret timeout', 'ssh', ORG, null, null, { targets: [H(1)], timeout: { password: PW } }, 'UNKNOWN LEAVE UNRECOGNIZED null'],
  ['ssh secret port', 'ssh', ORG, null, null, { port: 'S5ASENTINEL-SECRET' }, 'UNKNOWN LEAVE UNRECOGNIZED null'],
  ['L9 ssh with credential', 'ssh', ORG, 90, null, { _targets: [H(9)] }, 'L9 LEAVE DUAL_CREDENTIAL_MISMATCH null'],
  ['L9 nmap with credential', 'nmap', ORG, 90, null, { _targets: [H(9)] }, 'L9 LEAVE DUAL_CREDENTIAL_MISMATCH null'],
  ['L9 nmap userinfo', 'nmap', ORG, null, null, { _targets: [`u:${PW}@${H(9)}`] }, 'L11 LEAVE NMAP_SECRET_NO_CONSUMER null'],
  ['L9 ssh userinfo', 'ssh', ORG, null, null, { _targets: [`root:${PW}@${H(9)}`] }, 'L11 CONVERT INLINE_CREDENTIAL ssh_password'],
  ['L11 percent-encoded userinfo', 'ssh', ORG, null, null, { targets: [`root:s5asentinel%40pw@${H(1)}`] }, 'L11 LEAVE TARGET_SECRET null'],
  ['L1d port is never stripped', 'ssh', ORG, 90, null, ssh([`${H(1)}:2222`]), 'L1d LEAVE TARGET_GRAMMAR null'],
  ['nested past the depth cap', 'ssh', ORG, null, null, nested(MAX_CONFIG_DEPTH + 8), 'L12 LEAVE MALFORMED null'],
  ['L1d wrong-key envelope', 'ssh', ORG, 97, null, ssh([H(1)]), 'L1d LEAVE DUAL_CREDENTIAL_MISMATCH'],
  ['L1d garbage envelope', 'ssh', ORG, 98, null, ssh([H(1)]), 'L1d LEAVE DUAL_CREDENTIAL_MISMATCH'],
  ['L1d plaintext stored payload', 'ssh', ORG, 99, null, ssh([H(1)]), 'L1d LEAVE DUAL_CREDENTIAL_MISMATCH'],
];
// Stored at +02:00 with microseconds; the plan must carry it as exact UTC.
const UPDATED_AT = ['2026-10-01 14:34:56.123456+02', '2026-10-01T12:34:56.123456Z'];
const LITERALS = ['192.168.1.0', '10.0.0.0', 'us-east-1', 'dc=', 'BEGIN OPENSSH', '2001:db8'];

const OUT_DIR = mkdtempSync(join(tmpdir(), 's5a-plan-'));
let outs = 0;
const outPath = () => join(OUT_DIR, `plan-${outs++}.json`);
async function run(argv = ['--out', outPath()], env: NodeJS.ProcessEnv = { ...ENV, CREDENTIAL_ENCRYPTION_KEY: KEY }, open = jest.fn((_config: unknown) => client), classify?: Parameters<typeof main>[4]) {
  const err: string[] = [];
  const path = argv[argv.indexOf('--out') + 1] ?? '';
  queries.length = 0;
  const code = await main(argv, env, { stderr: line => err.push(line) }, open, classify);
  return { code, out: existsSync(path) ? readFileSync(path, 'utf8') : '', err: err.join('\n'), open, path };
}
/**
 * Spies on the lowest in-process sinks, wired as in production: console is a real Console on the process streams and
 * the shared logger runs at its most verbose level, so anything printed reaches process.stdout/stderr.write or a
 * logger transport. Restored by the returned collector.
 */
function spyOutputs(): () => string {
  expect(logger.transports.length).toBeGreaterThan(0); // the transport sink exists, so its spy is not vacuous
  const [jestConsole, level] = [global.console, logger.level];
  global.console = new Console(process.stdout, process.stderr);
  logger.level = 'silly';
  const spies: jest.SpyInstance[] = [jest.spyOn(process.stdout, 'write'), jest.spyOn(process.stderr, 'write'),
    ...logger.transports.map(transport => jest.spyOn(transport as unknown as { log: () => void }, 'log'))];
  return () => {
    [global.console, logger.level] = [jestConsole, level];
    const seen = spies.flatMap(spy => spy.mock.calls).map(call => inspect(call, { depth: 8 })).join('\n');
    spies.forEach(spy => spy.mockRestore());
    return seen;
  };
}
const expectValueFree = (output: string) => {
  expect(output.toLowerCase()).not.toContain('s5asentinel');
  for (const literal of LITERALS) expect(output).not.toContain(literal);
};

beforeAll(async () => {
  const schema = readFileSync(join(__dirname, '../../../../database/src/postgres/migrations/001_complete_schema.sql'), 'utf8');
  for (const table of ['credentials', 'discovery_definitions']) {
    await send('exec', schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))![0]);
  }
  await send('exec', `ALTER TABLE discovery_definitions ADD COLUMN organization_id UUID; ALTER TABLE credentials ADD COLUMN organization_id UUID;
    ALTER TABLE discovery_definitions DROP CONSTRAINT discovery_definitions_provider_check;`);
  const service = getEncryptionService(KEY);
  for (const [n, org, owner, protocol, payload, raw] of CREDENTIALS) {
    const envelope = raw ?? service.encrypt(JSON.stringify(payload));
    ENVELOPE_IDS.set(String((envelope as { iv?: unknown }).iv), n);
    await send('query', `INSERT INTO credentials (id, name, protocol, scope, credentials, created_by, organization_id) VALUES ($1, 's5asentinel-cred', $2, 'ssh', $3, $4, $5)`,
      [uuid(n), protocol, JSON.stringify(envelope), owner, org]);
  }
  for (const [index, [name, provider, org, credential, set, config]] of FIXTURES.entries()) {
    await send('query', `INSERT INTO discovery_definitions (id, name, provider, credential_id, credential_set_id, created_by, organization_id, config, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [uuid(index + 1), `S5ASENTINEL-NAME ${name}`, provider, credential && uuid(credential), set && uuid(set), OWNER, org, JSON.stringify(config), UPDATED_AT[0]]);
  }
});
afterAll(() => {
  host.kill();
  rmSync(OUT_DIR, { recursive: true });
});

describe('migrate-legacy-discovery-definitions (dry run, PGlite)', () => {
  it('classifies every row, NULL org included, with the exact §3.2 disposition and reason, and digests the plan', async () => {
    const { code, out } = await run();
    expect(code).toBe(0);
    const plan = JSON.parse(out);
    expect(plan.rows).toEqual(FIXTURES.map(([, provider, org, , , , expected], index) => {
      const [shape, disposition, reason, protocol = 'null'] = expected.split(' ');
      return {
        definition_id: uuid(index + 1), organization_id: org, provider: provider.startsWith('s5asentinel') ? 'OTHER' : provider, shape, disposition, reason,
        new_credential_protocol: protocol === 'null' ? null : protocol, updated_at: UPDATED_AT[1], key_skeleton_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      };
    }));
    expect(plan.counts.null_organization).toBe(4);
    expect(plan.plan_sha256).toBe(createHash('sha256').update(JSON.stringify({ rows: plan.rows, counts: plan.counts })).digest('hex'));
  });

  it('issues only SELECT statements', async () => {
    expect((await run()).code).toBe(0);
    expect(queries.length).toBeGreaterThan(0);
    for (const sql of queries) expect(sql).toMatch(/^SELECT [^;]*$/);
  });

  it('never prints a marker, name, target, credential or decoded payload, on any output channel', async () => {
    // The run decodes the STRIP_EQUAL row (#90), fails to decode #97/#98 and hits the depth cap on one row.
    const outputs = spyOutputs();
    const { code, out, err } = await run();
    const seen = outputs();
    expect([code, JSON.parse(out).rows.some((row: { disposition: string }) => row.disposition === 'STRIP_EQUAL')]).toEqual([0, true]);
    expectValueFree(`${out}\n${err}\n${seen}`);
  });

  it('without the encryption key an equal L1d payload is unproven: DUAL_CREDENTIAL_MISMATCH', async () => {
    const { code, out } = await run(undefined, ENV);
    expect(code).toBe(0);
    expect(JSON.parse(out).rows[5]).toMatchObject({ shape: 'L1d', disposition: 'LEAVE', reason: 'DUAL_CREDENTIAL_MISMATCH' });
  });

  it('key_skeleton_sha256 digests the sorted config key paths only: values never change it, keys always do', async () => {
    const rows = JSON.parse((await run()).out).rows as Array<Record<string, string>>;
    const skeleton = (name: string) => rows[FIXTURES.findIndex(([fixture]) => fixture === name)]!['key_skeleton_sha256'];
    // Same key sets, different values (targets, ports, passwords, org): one digest.
    expect(new Set(['L1 uniform port', 'L1 mixed ports', 'L1d equal payload', 'NULL org'].map(skeleton)).size).toBe(1);
    expect(skeleton('L10 shared')).toBe(skeleton('L10 heterogeneous'));
    // A renamed, added or removed key changes it.
    expect(skeleton('L1b PEM')).not.toBe(skeleton('L1 uniform port'));
    expect(skeleton('unknown')).not.toBe(skeleton('already safe'));
    // Canonical form, pinned: the sorted JSON key paths, no values.
    const paths = ['["credentials","password"]', '["credentials","username"]', '["credentials"]', '["targets"]'];
    expect(skeleton('L1 uniform port')).toBe(createHash('sha256').update(JSON.stringify(paths)).digest('hex'));
  });

  it('decodes only credentials that pass the org, owner and protocol gate', async () => {
    const decrypt = jest.spyOn(EncryptionService.prototype, 'decrypt');
    try {
      expect((await run()).code).toBe(0);
      expect(decrypt.mock.calls.map(([envelope]) => ENVELOPE_IDS.get(envelope.iv)).sort()).toStrictEqual([90, 91, 96, 97, 98]);
    } finally {
      decrypt.mockRestore();
    }
  });

  it('the CLI exits only after its output stream has flushed', () => {
    const exit = jest.fn();
    let flushed: (() => void) | undefined;
    try {
      exitAfterFlush(3, (_chunk, done) => { flushed = done; }, exit);
      expect([exit.mock.calls.length, process.exitCode]).toEqual([0, 3]);
      flushed!();
      expect(exit.mock.calls).toEqual([[3]]);
    } finally {
      process.exitCode = undefined;
    }
  });

  it('the allow-list encoder aborts with exit 2 and prints nothing of an injected field or free-text value', async () => {
    const injections = [{ name: 'S5ASENTINEL-INJECTED' }, { reason: 'S5ASENTINEL free text' }];
    for (const injection of injections) {
      const { code, out, err } = await run(undefined, undefined, undefined, () => ({ shape: 'L1', disposition: 'LEAVE', reason: 'MALFORMED', new_credential_protocol: null, ...injection }) as never);
      expect([code, out]).toEqual([2, '']);
      expectValueFree(err);
    }
  });

  it('refuses --apply, unknown or valueless flags, a missing --out and bad settings with exit 1 before any connection', async () => {
    const path = outPath();
    const cases = [[['--apply']], [['--plan', 'p', '--sha256', 'a'.repeat(64)]], [['--bogus']], [['--organization-id']], [[]], [['--out']],
      [['--out', path, '--apply']], [['--out', path], { ...ENV, CMDB_MIGRATION_POSTGRES_PORT: 'x' }]] as Array<[string[], NodeJS.ProcessEnv?]>;
    for (const [argv, env] of cases) {
      const { code, open } = await run(argv, env);
      expect([code, existsSync(path)]).toEqual([1, false]);
      expect(open).not.toHaveBeenCalled();
    }
  });

  it('refuses cleartext or unverified TLS to any host that is not loopback or a Unix socket, before connecting', async () => {
    const env = (host: string, ssl?: string) => ({ ...ENV, CMDB_MIGRATION_POSTGRES_HOST: host, ...(ssl === undefined ? {} : { CMDB_MIGRATION_POSTGRES_SSL: ssl }) });
    const refused: Array<[string, string?]> = [['db.example'], ['192.0.2.10', 'require'], ['127.0.0.1.evil.com'], ['localhost.example'], ['0.0.0.0'], ['::ffff:127.0.0.1', 'require']];
    for (const [host, ssl] of refused) {
      const { code, err, open, path } = await run(undefined, env(host, ssl));
      expect([code, err, existsSync(path)]).toEqual([1, 'migrate-legacy-discovery-definitions: refused: a non-loopback host needs CMDB_MIGRATION_POSTGRES_SSL=verify-full', false]);
      expect(open).not.toHaveBeenCalled();
    }
    // verify-full cannot verify an IP literal (pg sends no servername), so it needs a DNS name off loopback.
    for (const host of ['192.0.2.10', '2001:db8::1']) {
      const { code, err, open, path } = await run(undefined, env(host, 'verify-full'));
      expect([code, err, existsSync(path)]).toEqual([1, 'migrate-legacy-discovery-definitions: refused: verify-full needs a DNS host name, not an IP literal', false]);
      expect(open).not.toHaveBeenCalled();
    }
    const allowed: Array<[string, string?]> = [['db.example', 'verify-full'], ['127.0.0.1', 'verify-full'], ['127.0.0.1'], ['127.8.9.10', 'require'], ['::1'], ['localhost'], ['/var/run/postgresql']];
    for (const [host, ssl] of allowed) {
      const { code, open } = await run(undefined, env(host, ssl));
      expect([code, open.mock.calls[0]?.[0]]).toEqual([0, expect.objectContaining({ _host: host, ssl: ssl ?? false })]);
    }
    // verify-full reaches pg as a verifying TLS config (certificate chain and host name); no socket is opened.
    const pg = openPostgres({ _host: 'db.example', _port: 5432, _database: 'd', _user: 'u', _password: 'p', ssl: 'verify-full' }) as PostgresClient;
    expect(pg.pool.options.ssl).toEqual({ rejectUnauthorized: true });
    await pg.close();
  });

  it('writes the plan only to a new --out file with mode 0600, never to stdout, and refuses an existing path', async () => {
    const stdout = jest.spyOn(process.stdout, 'write');
    const { code, out, path } = await run();
    expect([code, statSync(path).mode & 0o777, JSON.parse(out).rows.length]).toEqual([0, 0o600, FIXTURES.length]);
    expect(stdout.mock.calls.flat().join('')).not.toContain('plan_sha256');
    stdout.mockRestore();
    const existing = outPath();
    writeFileSync(existing, 'S5A-KEEP');
    const again = await run(['--out', existing]);
    expect([again.code, again.err, readFileSync(existing, 'utf8')]).toEqual([1, 'migrate-legacy-discovery-definitions: refused: --out must be a new file', 'S5A-KEEP']);
    expect(again.open).not.toHaveBeenCalled();
  });

  it('as a real process: stdout stays empty and stderr carries no secret or error message', () => {
    const path = outPath();
    // Loopback port 1: nothing listens, so the run fails after PostgresClient logs (rerouted to stderr).
    const child = spawnSync(process.execPath, ['-r', join(__dirname, 'fixtures/ts-source-register.cjs'), join(__dirname, '../migrate-legacy-discovery-definitions.ts'), '--out', path], {
      env: { PATH: process.env['PATH'] ?? '', ...ENV, CMDB_MIGRATION_POSTGRES_PORT: '1', CREDENTIAL_ENCRYPTION_KEY: KEY }, encoding: 'utf8', timeout: 60_000,
    });
    expect([child.status, child.stdout, existsSync(path)]).toEqual([1, '', false]);
    expect(child.stderr).toContain('PostgreSQL client initialized WITHOUT SSL');
    expect(child.stderr.trimEnd().split('\n').at(-1)).toBe('migrate-legacy-discovery-definitions: failed (Error)');
    expectValueFree(child.stderr);
    expect(child.stderr).not.toMatch(/connect ECONNREFUSED|127\.0\.0\.1:1|\n\s+at /); // the error message and stack
  }, 60_000);

  it('a failing run whose --out file vanished still exits 1 with fixed text only', async () => {
    const path = outPath();
    const vanishing: SqlClient = { query: async () => { rmSync(path); throw new Error(`S5ASENTINEL ${path}`); }, close: async () => undefined };
    const { code, err } = await run(['--out', path], undefined, jest.fn((_config: unknown) => vanishing));
    expect([code, err, existsSync(path)]).toEqual([1, 'migrate-legacy-discovery-definitions: failed (Error)', false]);
  });

  it('a connection failure prints fixed text with the error name and SQLSTATE only', async () => {
    const failing: SqlClient = { query: async () => { throw Object.assign(new Error(`password authentication failed for user u at postgres://u:${ENV.CMDB_MIGRATION_POSTGRES_PASSWORD}@h`), { code: '28P01' }); }, close: async () => undefined };
    const outputs = spyOutputs();
    const { code, out, err, path } = await run(undefined, undefined, jest.fn((_config: unknown) => failing));
    expectValueFree(outputs());
    expect([code, out, err, existsSync(path)]).toEqual([1, '', 'migrate-legacy-discovery-definitions: failed (Error, 28P01)', false]);
  });
});
