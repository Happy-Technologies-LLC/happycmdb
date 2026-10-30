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
import { CredentialCRUDService } from '../../../../database/src/postgres/credential-services/crud.service';
import { logger } from '../../../../common/src/utils/logger';
import { hasUnsafeDiscoveryDefinitionConfig, publicDiscoveryDefinitionConfig } from '../../../../common/src/utils/discovery-scan-config';
import { CLOSE_TIMEOUT_MS, encodePlan, exitAfterFlush, main, MAX_CONFIG_DEPTH, openPostgres, runCli, type SqlClient } from '../migrate-legacy-discovery-definitions';

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
const client: SqlClient = { query: async (sql, params) => (queries.push(sql), { rows: await send('query', sql, params) }), close: async () => undefined,
  async transaction(work) {
    await this.query('BEGIN');
    try {
      return await work(this).then(async result => (await this.query('COMMIT'), result));
    } catch (error) {
      await this.query('ROLLBACK');
      throw error;
    }
  } };

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
  // S5b bindings B1-B11 (#142 body); N1-N12 are cmdb-932's CONVERT-safety guards.
  ['B1 password plus key path', 'ssh', ORG, null, null, ssh([H(1)], { ...PASSWORD, privateKey: '/s5asentinel/k' }), 'L1 LEAVE UNRECOGNIZED'],
  ['B1 key path plus extra key', 'ssh', ORG, null, null, ssh([H(1)], { username: U, privateKey: '/s5asentinel/k', port: 22 }), 'L1 LEAVE UNRECOGNIZED'],
  ['B1 PEM after a newline', 'ssh', ORG, null, null, ssh([H(1)], { username: U, privateKey: `\n${PEM}` }), 'L1 CONVERT INLINE_CREDENTIAL ssh_key'],
  ['B1 PEM inside a path', 'ssh', ORG, null, null, ssh([H(1)], { username: U, privateKey: `/k${PEM}` }), 'L1 LEAVE UNRECOGNIZED'],
  ['B2 nmap _targets non-string', 'nmap', ORG, null, null, { _targets: [H(9), 7] }, 'L9 LEAVE UNRECOGNIZED'],
  ['B2 L4 targets non-string', 'nmap', ORG, null, null, { targets: [{ password: PW }], scanOptions: { ports: '22' } }, 'L4 LEAVE UNRECOGNIZED'],
  ['B2 L6 targets non-string', 'nmap', ORG, null, null, { targets: [7], ports: '22' }, 'L6 LEAVE UNRECOGNIZED'],
  ['B3 ? in the user half', 'ssh', ORG, null, null, { targets: [`ro?ot:${PW}@${H(1)}`] }, 'L11 LEAVE TARGET_SECRET'],
  ['B3 # in the password half', 'ssh', ORG, null, null, { targets: [`root:S5A#PW@${H(1)}`] }, 'L11 LEAVE TARGET_SECRET'],
  ['B4 kubernetes inline credentials', 'kubernetes', ORG, null, null, { context: 'c', credentials: { token: PW } }, 'UNKNOWN LEAVE UNRECOGNIZED'],
  ['B4 seed AD inline credentials', 'activedirectory', ORG, null, null, { ldap_url: `ldap://${H(7)}`, credentials: PASSWORD }, 'L2 LEAVE UNSUPPORTED_PROVIDER'],
  ['B5 L1d NULL org is never decoded', 'ssh', null, 90, null, ssh([H(1)]), 'L1d LEAVE NO_VERIFIED_ORG'],
  ['B5 L5 with a credential', 'ssh', ORG, 90, null, { targets: [H(5)], port: 22 }, 'UNKNOWN LEAVE UNRECOGNIZED'],
  ['B6 PEM with passphrase', 'ssh', ORG, null, null, ssh([`${H(1)}:2200`], { username: U, privateKey: PEM, passphrase: 'S5ASENTINEL-PP' }), 'L1 CONVERT INLINE_CREDENTIAL ssh_key'],
  ['B6 empty passphrase is not a passphrase', 'ssh', ORG, null, null, ssh([H(1)], { username: U, privateKey: PEM, passphrase: '' }), 'L1 LEAVE UNRECOGNIZED'],
  ['B9 range userinfo beside targets', 'ssh', ORG, null, null, { targets: [H(1)], range: `ssh://u:${PW}@${H(2)}` }, 'L11 LEAVE TARGET_SECRET'],
  ['B9 _targets userinfo beside targets', 'nmap', ORG, null, null, { targets: [H(1)], _targets: [`u:${PW}@${H(2)}`] }, 'L11 LEAVE NMAP_SECRET_NO_CONSUMER'],
  ['B10 empty privateKey is absent', 'ssh', ORG, null, null, ssh([H(1)], { ...PASSWORD, privateKey: '' }), 'L1 CONVERT INLINE_CREDENTIAL ssh_password'],
  ['N1 L11 extra key', 'ssh', ORG, null, null, { targets: [`root:${PW}@${H(1)}`], timeout: 5 }, 'L11 LEAVE TARGET_SECRET'],
  ['N2 L10 extra key', 'ssh', ORG, null, null, { hosts: [{ host: H(1), ...PASSWORD }], port: 22 }, 'L10 LEAVE UNRECOGNIZED'],
  ['N3 L10 entry extra key', 'ssh', ORG, null, null, { hosts: [{ host: H(1), ...PASSWORD, token: PW }] }, 'L10 LEAVE UNRECOGNIZED'],
  ['N4 L4 non-mode scanOptions key', 'nmap', ORG, null, null, { targets: [H(4)], scanOptions: { ports: '22', script: PW } }, 'L4 LEAVE UNRECOGNIZED'],
  ['N5 L1 extra key', 'ssh', ORG, null, null, { ...ssh([H(1)]), port: 22 }, 'L1 LEAVE UNRECOGNIZED'],
  ['N6 port out of range', 'ssh', ORG, null, null, ssh([`${H(1)}:65536`]), 'L1 LEAVE TARGET_GRAMMAR'],
  ['N7 scan_type not a word', 'nmap', ORG, null, null, { targets: [H(6)], scan_type: 'S5ASENTINEL PW!' }, 'L6 LEAVE UNRECOGNIZED'],
  ['N8 ports not a port list', 'nmap', ORG, null, null, { targets: [H(6)], ports: 'S5ASENTINEL' }, 'L6 LEAVE UNRECOGNIZED'],
  ['N11 L11 bad host', 'ssh', ORG, null, null, { targets: [`root:${PW}@[2001:db8::5a]`] }, 'L11 LEAVE TARGET_SECRET'],
  ['N12 ssh CIDR', 'ssh', ORG, null, null, ssh(['198.51.100.0/24']), 'L1 LEAVE TARGET_GRAMMAR'],
];
// Stored at +02:00 with microseconds; the plan must carry it as exact UTC.
const UPDATED_AT = ['2026-10-01 14:34:56.123456+02', '2026-10-01T12:34:56.123456Z'];
const LITERALS = ['192.168.1.0', '10.0.0.0', 'us-east-1', 'dc=', 'BEGIN OPENSSH', '2001:db8'];
const MIGRATIONS = join(__dirname, '../../../../database/src/postgres/migrations');
const LEDGER_041 = readFileSync(join(MIGRATIONS, '041_discovery_definition_migration_ledger.sql'), 'utf8');

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
  // 021's tenant name index (the converted credential's idempotency guard), the other credential referrers, and 041.
  await send('exec', `CREATE UNIQUE INDEX idx_credentials_unique_name ON credentials (name, created_by, organization_id) WHERE organization_id IS NOT NULL;
    CREATE TABLE credential_sets (credential_ids UUID[]); CREATE TABLE connector_configurations (credential_id UUID); ${LEDGER_041}`);
  const service = getEncryptionService(KEY);
  for (const [n, org, owner, protocol, payload, raw] of CREDENTIALS) {
    const envelope = raw ?? service.encrypt(JSON.stringify(payload));
    ENVELOPE_IDS.set(String((envelope as { iv?: unknown }).iv), n);
    await send('query', `INSERT INTO credentials (id, name, protocol, scope, credentials, created_by, organization_id) VALUES ($1, $6, $2, 'ssh', $3, $4, $5)`,
      [uuid(n), protocol, JSON.stringify(envelope), owner, org, `s5asentinel-cred-${n}`]);
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
    expect(plan.counts.null_organization).toBe(5);
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

  it('B7: a decode failure is visible as fixed text plus a count (#97 and #98 fail under the key)', async () => {
    expect((await run()).err).toBe('migrate-legacy-discovery-definitions: credential decode failures: 2');
    expect((await run(undefined, ENV)).err).toBe('');
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
    const vanishing: SqlClient = { ...client, query: async () => { rmSync(path); throw new Error(`S5ASENTINEL ${path}`); }, close: async () => undefined };
    const { code, err } = await run(['--out', path], undefined, jest.fn((_config: unknown) => vanishing));
    expect([code, err, existsSync(path)]).toEqual([1, 'migrate-legacy-discovery-definitions: failed (Error)', false]);
  });

  it('a connection failure prints fixed text with the error name and SQLSTATE only', async () => {
    const failing: SqlClient = { ...client, query: async () => { throw Object.assign(new Error(`password authentication failed for user u at postgres://u:${ENV.CMDB_MIGRATION_POSTGRES_PASSWORD}@h`), { code: '28P01' }); }, close: async () => undefined };
    const outputs = spyOutputs();
    const { code, out, err, path } = await run(undefined, undefined, jest.fn((_config: unknown) => failing));
    expectValueFree(outputs());
    expect([code, out, err, existsSync(path)]).toEqual([1, '', 'migrate-legacy-discovery-definitions: failed (Error, 28P01)', false]);
  });
});

describe('migrate-legacy-discovery-definitions write modes (S5b, 041 on PGlite; in order)', () => {
  type Receipt = { receipt_id: string; rows: Array<{ definition_id: string; action: string }> };
  const q = (sql: string, params?: unknown[]) => send('query', sql, params);
  const sha = (body: string) => createHash('sha256').update(body).digest('hex');
  const count = async (from: string, params?: unknown[]) => Number((await q(`SELECT count(*)::int AS n FROM ${from}`, params))[0]!['n']);
  const row = async (n: number) => (await q('SELECT config, credential_id, config::text AS text FROM discovery_definitions WHERE id = $1', [uuid(n)]))[0]!;
  const fixture = (name: string) => FIXTURES.findIndex(([label]) => label === name) + 1;
  const add = (n: number, config = JSON.stringify(ssh([H(n)])), provider = 'ssh', credential: string | null = null) => q(`INSERT INTO discovery_definitions
    (id, name, provider, created_by, organization_id, config, updated_at, credential_id) VALUES ($1, 'S5ASENTINEL-NAME', $6, $2, $3, $4::jsonb, $5, $7)`, [uuid(n), OWNER, ORG, config, UPDATED_AT[0], provider, credential]);
  type Classify = Parameters<typeof main>[4];
  const planOf = async (ids: string[], classify?: Classify) =>
    `${encodePlan(JSON.parse((await run(undefined, undefined, undefined, classify)).out).rows.filter((plan: { definition_id: string }) => ids.includes(plan.definition_id)))}\n`;
  const decrypt = (envelope: unknown) => JSON.parse(getEncryptionService(KEY).decrypt(envelope as never));
  /** Writes the input file and runs one mode on it with its sha256 (or `digest`). */
  async function write(mode: string, body: string, { digest = sha(body), env = { ...ENV, CREDENTIAL_ENCRYPTION_KEY: KEY } as NodeJS.ProcessEnv, open = jest.fn((_config: unknown) => client), classify = undefined as Classify } = {}) {
    const file = outPath();
    writeFileSync(file, body);
    const result = await run([`--${mode}`, ['apply', 'retire'].includes(mode) ? '--plan' : '--receipt', file, '--sha256', digest, '--out', outPath()], env, open, classify);
    return { ...result, receipt: (result.out === '' ? null : JSON.parse(result.out)) as Receipt };
  }
  let [plan, applied, partial, resumed] = ['', '', '', ''];

  it('(a) a wrong --sha256, a tampered or foreign input, a missing key or an unverified host refuses: exit 1, no connection, no receipt', async () => {
    plan = (await run()).out;
    const cases = [await write('apply', plan, { digest: sha(`${plan} `) }), await write('apply', plan.replace('"LEAVE"', '"CONVERT"')), await write('apply', plan.trimEnd()),
      await write('rollback', plan), await write('apply', plan, { env: ENV }), await write('apply', plan, { env: { ...ENV, CMDB_MIGRATION_POSTGRES_HOST: 'db.example', CREDENTIAL_ENCRYPTION_KEY: KEY } })];
    for (const { code, open, out } of cases) expect([code, open.mock.calls.length, out]).toEqual([1, 0, '']);
    expect((await write('apply', `${encodePlan([])}\n`)).code).toBe(0); // the same, correctly signed, runs
  });

  it('(b)(h) --apply converts per §3.2/§3.3 into envelope-only credentials and escrow, one ledger row per planned row, no value anywhere', async () => {
    const create = jest.spyOn(CredentialCRUDService.prototype, 'create');
    const outputs = spyOutputs();
    const result = await write('apply', plan);
    const seen = outputs();
    expect([result.code, create.mock.calls.length]).toEqual([0, 0]); // R7: never CredentialCRUDService.create
    create.mockRestore();
    applied = result.out;
    const planned = (JSON.parse(plan).rows as Array<Record<string, string>>).filter(entry => entry['disposition'] !== 'SKIP');
    const action: Record<string, string> = { INLINE_CREDENTIAL: 'converted', ALIAS_RENAME: 'alias_rename', BENIGN_STRIP: 'benign_strip', PAYLOAD_EQUAL: 'strip_equal' };
    expect(result.receipt.rows).toEqual(planned.map(entry => ({ definition_id: entry['definition_id'], action: entry['disposition'] === 'LEAVE' ? 'planned_leave' : action[entry['reason']!] })));
    const changed = result.receipt.rows.filter(entry => entry.action !== 'planned_leave');
    expect([await count(`credentials WHERE name LIKE 'legacy-discovery-%'`), await count('discovery_definition_migration_escrow'), await count('discovery_definition_migrations')])
      .toEqual([result.receipt.rows.filter(entry => entry.action === 'converted').length, changed.length, planned.length]);
    // L1: an ssh_password envelope of the row's org and owner; GET shows {targets} and credential_id; the inventory predicate drops it.
    const l1 = await row(1);
    const [credential] = await q('SELECT * FROM credentials WHERE id = $1', [l1['credential_id']]);
    expect(credential).toMatchObject({ name: `legacy-discovery-${uuid(1)}`, protocol: 'ssh_password', scope: 'ssh', created_by: OWNER, organization_id: ORG, tags: ['hap-774-migrated'] });
    expect([Object.keys(credential!['credentials'] as object).sort(), decrypt(credential!['credentials'])]).toEqual([['authTag', 'encryptedData', 'iv'], { ...PASSWORD, port: 2222 }]);
    expect([publicDiscoveryDefinitionConfig(l1['config']), hasUnsafeDiscoveryDefinitionConfig(l1['config'])]).toEqual([{ targets: [H(1), H(2)] }, false]);
    const [key] = await q('SELECT c.protocol, c.credentials FROM credentials c JOIN discovery_definitions d ON d.credential_id = c.id WHERE d.id = $1', [uuid(fixture('B6 PEM with passphrase'))]);
    expect([key!['protocol'], decrypt(key!['credentials'])]).toEqual(['ssh_key', { username: U, private_key: PEM, passphrase: 'S5ASENTINEL-PP', port: 2200 }]);
    for (const { definition_id: id } of changed) expect(hasUnsafeDiscoveryDefinitionConfig((await q('SELECT config FROM discovery_definitions WHERE id = $1', [id]))[0]!['config'])).toBe(false);
    // Escrow: an envelope of the exact original config per changed row, nothing else.
    const escrow = await q('SELECT definition_id, envelope FROM discovery_definition_migration_escrow');
    for (const { definition_id: id, envelope } of escrow) expect([Object.keys(JSON.parse(envelope as string)).sort(), decrypt(JSON.parse(envelope as string))]).toEqual([['authTag', 'encryptedData', 'iv'], FIXTURES[Number(String(id).slice(-12)) - 1]![5]]);
    expectValueFree([seen, result.err, result.out, JSON.stringify(await q('SELECT * FROM discovery_definition_migrations'))].join('\n'));
    expect(JSON.stringify(escrow).toLowerCase()).not.toContain('s5asentinel');
  }, 30_000);

  it('(c) a re-run of the same plan changes nothing; a taken credential name fails that row closed', async () => {
    const tables = ['credentials', 'discovery_definition_migration_escrow', 'discovery_definition_migrations'];
    const before = await Promise.all(tables.map(table => count(table)));
    expect(await write('apply', plan)).toMatchObject({ code: 0, out: applied });
    expect(await Promise.all(tables.map(table => count(table)))).toEqual(before);
    await add(201);
    await q(`INSERT INTO credentials (name, protocol, scope, credentials, created_by, organization_id) VALUES ($1, 'ssh_password', 'ssh', '{}', $2, $3)`, [`legacy-discovery-${uuid(201)}`, OWNER, ORG]);
    const taken = await write('apply', await planOf([uuid(201)]));
    expect([taken.code, taken.receipt.rows, hasUnsafeDiscoveryDefinitionConfig((await row(201))['config'])]).toEqual([1, [{ definition_id: uuid(201), action: 'failed' }], true]);
    expect([await count('discovery_definition_migration_escrow WHERE definition_id = $1', [uuid(201)]), await count('discovery_definition_migrations WHERE definition_id = $1', [uuid(201)])]).toEqual([0, 0]);
  }, 30_000);

  it('(d) a row whose updated_at moved by 1 µs since the plan is ledgered drifted and left untouched', async () => {
    await add(202);
    const body = await planOf([uuid(202)]);
    await q(`UPDATE discovery_definitions SET updated_at = updated_at + interval '1 microsecond' WHERE id = $1`, [uuid(202)]);
    const { code, receipt } = await write('apply', body);
    expect([code, receipt.rows, (await row(202))['credential_id'], hasUnsafeDiscoveryDefinitionConfig((await row(202))['config'])]).toEqual([0, [{ definition_id: uuid(202), action: 'drifted' }], null, true]);
    expect([await count('discovery_definition_migration_escrow WHERE definition_id = $1', [uuid(202)]), await q('SELECT action FROM discovery_definition_migrations WHERE definition_id = $1', [uuid(202)])]).toEqual([0, [{ action: 'drifted' }]]);
  }, 30_000);

  it('a partial apply resumes: a re-run of the same plan applies only the failed rows, with no duplicate credential, escrow or ledger row', async () => {
    const ids = [203, 204, 205].map(uuid);
    for (const n of [203, 204, 205]) await add(n);
    const body = await planOf(ids);
    // Rows 2 and 3 fail mid-run, at their escrow write.
    const faulty: SqlClient = { ...client, query: (sql, params) => sql.startsWith('INSERT INTO discovery_definition_migration_escrow') && params?.[0] !== ids[0]
      ? Promise.reject(new Error('S5ASENTINEL')) : client.query(sql, params) };
    const first = await write('apply', body, { open: jest.fn((_config: unknown) => faulty) });
    partial = first.out;
    expect([first.code, first.receipt.rows.map(entry => entry.action), await count('credentials WHERE name = ANY($1)', [ids.map(id => `legacy-discovery-${id}`)])]).toEqual([1, ['converted', 'failed', 'failed'], 1]);
    expectValueFree(first.err);
    const second = await write('apply', body);
    resumed = second.out;
    expect([second.code, second.receipt.receipt_id, second.receipt.rows.map(entry => entry.action)]).toEqual([0, first.receipt.receipt_id, ['converted', 'converted', 'converted']]);
    expect([await count('credentials WHERE name = ANY($1)', [ids.map(id => `legacy-discovery-${id}`)]), await count('discovery_definition_migration_escrow WHERE definition_id = ANY($1)', [ids]),
      await count('discovery_definition_migrations WHERE definition_id = ANY($1)', [ids])]).toEqual([3, 3, 3]);
  }, 30_000);

  it('(e) --rollback restores the exact original JSON and prior credential, drops the escrow and only unused unmodified credentials, refuses a moved row', async () => {
    const [l1, l1d, l10, ...others] = ['L1 uniform port', 'L1d equal payload', 'L10 shared', 'L11 ssh one credential', 'L1b PEM', 'B10 empty privateKey is absent', 'B1 PEM after a newline'].map(fixture);
    await q(`UPDATE discovery_definitions SET updated_at = updated_at + interval '1 microsecond' WHERE id = $1`, [uuid(l10!)]);
    const created = async (n: number) => (await row(n))['credential_id'];
    const [l1Credential, kept] = [await created(l1!), await Promise.all(others.map(created))];
    // Kept: in use by another definition, modified after apply, in a credential set, used by a connector.
    await q('UPDATE discovery_definitions SET credential_id = $1 WHERE id = $2', [kept[0], uuid(202)]);
    await q(`UPDATE credentials SET updated_at = updated_at + interval '1 second' WHERE id = $1`, [kept[1]]);
    await q('INSERT INTO credential_sets (credential_ids) VALUES (ARRAY[$1::uuid])', [kept[2]]);
    await q('INSERT INTO connector_configurations (credential_id) VALUES ($1)', [kept[3]]);
    const outputs = spyOutputs();
    const { code, receipt, out, err } = await write('rollback', applied);
    expectValueFree(`${outputs()}\n${err}\n${out}`);
    const actions = Object.fromEntries(receipt.rows.map(entry => [entry.definition_id, entry.action]));
    expect([code, actions[uuid(l10!)], actions[uuid(l1!)], actions[uuid(l1d!)], new Set(Object.values(actions)).size]).toEqual([1, 'refused', 'rolled_back', 'rolled_back', 2]);
    for (const n of [l1!, l1d!, others[0]!]) expect((await row(n))['text']).toBe((await q('SELECT $1::jsonb::text AS text', [JSON.stringify(FIXTURES[n - 1]![5])]))[0]!['text']);
    expect([await created(l1!), await created(l1d!), hasUnsafeDiscoveryDefinitionConfig((await row(l10!))['config']), await count('discovery_definition_migration_escrow WHERE definition_id = ANY($1)',
      [receipt.rows.filter(entry => entry.action === 'rolled_back').map(entry => entry.definition_id)])]).toEqual([null, uuid(90), false, 0]);
    expect(await Promise.all([l1Credential, ...kept, uuid(90)].map(id => count('credentials WHERE id = $1', [id])))).toEqual([0, 1, 1, 1, 1, 1]);
  }, 30_000);

  it('(e) jsonb numbers come back byte-exact; a re-skeletoned escrow is refused; ledger `at` is taken after the lock; a rolled-back plan re-applies as drifted', async () => {
    const ids = [206, 207, 212];
    for (const [i, config] of ['{"ports": 80.0, "targets": ["h206.example"]}', '{"ports": 12345678901234567890, "targets": ["h207.example"]}', '{"ports": "22", "targets": ["h212.example"]}'].entries()) await add(ids[i]!, config, 'nmap');
    const original = await Promise.all(ids.map(async n => (await row(n))['text']));
    const body = await planOf(ids.map(uuid));
    const once = await write('apply', body);
    // Row 212's escrow is swapped for an envelope of another key set (same key): refused, never written back.
    await q('UPDATE discovery_definition_migration_escrow SET envelope = $1 WHERE definition_id = $2', [JSON.stringify(getEncryptionService(KEY).encrypt('{"targets": ["h212.example"], "tampered": 1}')), uuid(212)]);
    // Each row transaction starts, then waits (as for the row lock): its ledger `at` must be read after the wait, not at the start.
    const starts: string[] = [];
    const waiting: SqlClient = { ...client, async query(sql, params) {
      const result = await client.query(sql, params);
      if (sql === 'BEGIN') {
        starts.push(String((await client.query('SELECT now()::text AS t, pg_sleep(0.002)')).rows[0]!['t']));
      }
      return result;
    } };
    const back = await write('rollback', once.out, { open: jest.fn((_config: unknown) => waiting) });
    expect([once.receipt.rows.map(entry => entry.action), back.code, back.receipt.rows.map(entry => entry.action)]).toEqual([['benign_strip', 'benign_strip', 'benign_strip'], 1, ['rolled_back', 'rolled_back', 'refused']]);
    expect([Number((await q(`SELECT count(*) FILTER (WHERE l.at >= s.t::timestamptz + interval '2 milliseconds') AS n FROM unnest($1::uuid[], $2::text[]) AS s(id, t)
      JOIN discovery_definition_migrations l ON l.definition_id = s.id AND l.action = 'rolled_back'`, [ids.slice(0, 2).map(uuid), starts.slice(0, 2)]))[0]!['n']),
      hasUnsafeDiscoveryDefinitionConfig((await row(212))['config']), await Promise.all(ids.slice(0, 2).map(async n => (await row(n))['text'])), original[0]])
      .toEqual([2, false, original.slice(0, 2), '{"ports": 80.0, "targets": ["h206.example"]}']);
    const again = await write('apply', body);
    expect([again.code, again.receipt.rows.map(entry => entry.action)]).toEqual([0, ['drifted', 'drifted', 'benign_strip']]);
  }, 30_000);

  it('an L1d whose stored credential changed between plan and apply is re-classified and ledgered drifted', async () => {
    const envelope = (password: string) => JSON.stringify(getEncryptionService(KEY).encrypt(JSON.stringify({ ...PASSWORD, password })));
    await q(`INSERT INTO credentials (id, name, protocol, scope, credentials, created_by, organization_id) VALUES ($1, 's5asentinel-cred-209', 'ssh_password', 'ssh', $2, $3, $4)`, [uuid(209), envelope(PW), OWNER, ORG]);
    await add(208, undefined, 'ssh', uuid(209));
    const body = await planOf([uuid(208)]);
    await q('UPDATE credentials SET credentials = $1 WHERE id = $2', [envelope('S5ASENTINEL-PW-9'), uuid(209)]);
    const { code, receipt } = await write('apply', body);
    expect([JSON.parse(body).rows[0].disposition, code, receipt.rows, hasUnsafeDiscoveryDefinitionConfig((await row(208))['config'])]).toEqual(['STRIP_EQUAL', 0, [{ definition_id: uuid(208), action: 'drifted' }], true]);
  }, 30_000);

  it('the before-commit strict check rolls back a row whose converted config is still unsafe', async () => {
    await add(210, JSON.stringify({ _targets: ['S5ASENTINEL bad target'] }), 'nmap');
    const forced: Classify = () => ({ shape: 'L9', disposition: 'CONVERT', reason: 'ALIAS_RENAME', new_credential_protocol: null });
    const { code, receipt } = await write('apply', await planOf([uuid(210)], forced), { classify: forced });
    expect([code, receipt.rows, hasUnsafeDiscoveryDefinitionConfig((await row(210))['config']), await count('discovery_definition_migration_escrow WHERE definition_id = $1', [uuid(210)])])
      .toEqual([1, [{ definition_id: uuid(210), action: 'failed' }], true, 0]);
  }, 30_000);

  it('a rollback racing a re-run cannot land between its settled check and its report (no false converted)', async () => {
    await add(211);
    const body = await planOf([uuid(211)]);
    expect((await write('apply', body)).receipt.rows[0]!.action).toBe('converted');
    // A concurrent rollback commits right after the ledger read, unless this run already holds the row lock (then after its commit).
    let [locked, deferred, injected] = [false, false, false];
    const rollback = async () => {
      injected = true;
      await q(`UPDATE discovery_definitions SET config = $2::jsonb, credential_id = NULL, updated_at = clock_timestamp() WHERE id = $1`, [uuid(211), JSON.stringify(ssh([H(211)]))]);
      await q(`INSERT INTO discovery_definition_migrations (receipt_id, definition_id, action) VALUES (gen_random_uuid(), $1, 'rolled_back')`, [uuid(211)]);
    };
    const racing: SqlClient = { ...client, async query(sql, params) {
      locked = sql === 'BEGIN' ? false : locked || (/FOR UPDATE/.test(sql) && params?.[0] === uuid(211));
      const result = await client.query(sql, params);
      const settledRead = !injected && sql.startsWith('SELECT action FROM discovery_definition_migrations');
      deferred ||= settledRead && locked;
      if ((settledRead && !locked) || (!injected && deferred && sql === 'COMMIT')) {
        await rollback();
      }
      return result;
    } };
    const { receipt } = await write('apply', body, { open: jest.fn((_config: unknown) => racing) });
    expect([injected, deferred, receipt.rows[0]!.action]).toEqual([true, true, 'converted']);
  }, 30_000);

  it('(f) --finalize deletes the receipt\'s escrow; --rollback then refuses every row and changes nothing', async () => {
    const ids = [203, 204, 205].map(uuid);
    const outputs = spyOutputs();
    // The partial run-1 receipt finalizes only its own converted row; the rows run 2 resumed keep their escrow.
    const early = await write('finalize', partial);
    expect([early.receipt.rows, await count('discovery_definition_migration_escrow WHERE definition_id = ANY($1)', [ids])]).toEqual([[{ definition_id: ids[0], action: 'finalized' }], 2]);
    const finalized = await write('finalize', resumed);
    const back = await write('rollback', resumed);
    expectValueFree([outputs(), finalized.out, finalized.err, back.out, back.err].join('\n'));
    expect([finalized.code, finalized.receipt.rows, await count('discovery_definition_migration_escrow WHERE definition_id = ANY($1)', [ids])])
      .toEqual([0, ids.slice(1).map(id => ({ definition_id: id, action: 'finalized' })), 0]);
    expect([back.code, back.receipt.rows.map(entry => entry.action), hasUnsafeDiscoveryDefinitionConfig((await row(203))['config'])]).toEqual([1, ['refused', 'refused', 'refused'], false]);
  }, 30_000);

  it('--retire empties and deactivates only the listed unchanged LEAVE rows; a malformed retire file refuses with no connection', async () => {
    const rows = JSON.parse((await run()).out).rows as Array<Record<string, unknown>>;
    const [snmp, nmap, ad] = ['L3 SNMP', 'L11 nmap', 'L2 AD'].map(name => rows[fixture(name) - 1]!);
    const file = (list: unknown[], extra = {}) => `${JSON.stringify({ mode: 'retire', rows: list, ...extra })}\n`;
    const refused = [file([snmp, snmp]), file([snmp, rows.find(entry => entry['disposition'] !== 'LEAVE')]), file([{ ...snmp, name: 'S5ASENTINEL' }]), file([snmp], { note: 'x' }),
      file([]), `${JSON.stringify({ mode: 'retire', rows: [snmp] }, null, 1)}\n`];
    for (const body of refused) expect(await write('retire', body)).toMatchObject({ code: 1, out: '', open: expect.objectContaining({ mock: expect.objectContaining({ calls: [] }) }) });
    await q(`UPDATE discovery_definitions SET updated_at = updated_at + interval '1 microsecond' WHERE id = $1`, [ad!['definition_id']]);
    const outputs = spyOutputs();
    const { code, receipt, out, err } = await write('retire', file([snmp, nmap, ad]));
    expectValueFree(`${outputs()}\n${err}\n${out}`);
    expect([code, receipt.rows.map(entry => entry.action)]).toEqual([0, ['retired', 'retired', 'drifted']]);
    expect(await q('SELECT config, is_active FROM discovery_definitions WHERE id = ANY($1) ORDER BY id', [[snmp!['definition_id'], nmap!['definition_id'], ad!['definition_id']]]))
      .toEqual([{ config: FIXTURES[fixture('L2 AD') - 1]![5], is_active: true }, { config: {}, is_active: false }, { config: {}, is_active: false }]);
  }, 30_000);

  it('(g) the ledger refuses UPDATE, DELETE and TRUNCATE; cmdb_user has no access; the rollback drops exactly what 041 created', async () => {
    for (const sql of ['UPDATE discovery_definition_migrations SET reason = NULL', 'DELETE FROM discovery_definition_migrations', 'TRUNCATE discovery_definition_migrations']) {
      await expect(q(sql)).rejects.toThrow('discovery_definition_migrations is append-only');
    }
    await q('CREATE ROLE cmdb_user');
    for (const table of ['discovery_definition_migrations', 'discovery_definition_migration_escrow']) {
      await send('exec', 'BEGIN; SET LOCAL ROLE cmdb_user');
      await expect(q(`DELETE FROM ${table}`)).rejects.toThrow('permission denied');
      await q('ROLLBACK');
    }
    await send('exec', `CREATE SCHEMA cmdb; CREATE TABLE cmdb.schema_migrations (migration_name text); INSERT INTO cmdb.schema_migrations VALUES ('041_discovery_definition_migration_ledger.sql');
      ${readFileSync(join(MIGRATIONS, 'rollback/041_discovery_definition_migration_ledger.down.sql'), 'utf8')}`);
    expect(await q(`SELECT to_regclass('discovery_definition_migrations') AS ledger, to_regclass('discovery_definition_migration_escrow') AS escrow,
      to_regprocedure('discovery_definition_migrations_append_only()') AS trigger, to_regclass('discovery_definitions')::text AS kept, (SELECT count(*)::int FROM cmdb.schema_migrations) AS recorded`))
      .toEqual([{ ledger: null, escrow: null, trigger: null, kept: 'discovery_definitions', recorded: 0 }]);
  }, 30_000);

  it('#142 LOW-1: a failed run whose close() never settles still resolves 1, --out unlinked before close() is awaited', async () => {
    const path = outPath();
    let present: boolean | undefined;
    const hanging: SqlClient = { ...client, query: () => Promise.reject(new Error('S5ASENTINEL')), close: () => (present = existsSync(path), Promise.withResolvers<void>().promise) };
    expect([(await run(['--out', path], undefined, jest.fn((_config: unknown) => hanging))).code, present, existsSync(path)]).toEqual([1, false, false]);
  }, CLOSE_TIMEOUT_MS + 5_000);

  it('#142 LOW-1: the real CLI, when main never settles, exits 1 and leaves no --out', () => {
    const [path, cli] = [outPath(), JSON.stringify(join(__dirname, '../migrate-legacy-discovery-definitions.ts'))];
    // pg queries that never settle and hold no handle: the event loop drains with main still pending.
    const script = `require('pg').Pool.prototype.query = () => Promise.withResolvers().promise; process.argv = [process.execPath, ${cli}, '--out', ${JSON.stringify(path)}];
      require('module')._load(${cli}, null, true);`;
    const child = spawnSync(process.execPath, ['-r', join(__dirname, 'fixtures/ts-source-register.cjs'), '-e', script], { env: { PATH: process.env['PATH'] ?? '', ...ENV }, encoding: 'utf8', timeout: 60_000 });
    expect([child.status, existsSync(path)]).toEqual([1, false]);
  }, 60_000);

  it('a closeSync error on a successful run exits 1 and leaves no plan', async () => {
    const fs: { closeSync: (fd: number) => void } = jest.requireActual('fs');
    const realClose = fs.closeSync;
    const close = jest.spyOn(fs, 'closeSync').mockImplementationOnce(fd => {
      realClose(fd);
      throw new Error('EIO');
    });
    const { code, err, path } = await run(undefined, ENV);
    close.mockRestore();
    expect([code, err, existsSync(path)]).toEqual([1, 'migrate-legacy-discovery-definitions: failed (Error)', false]);
  });

  it('runCli: a rejected run prints fixed text and exits 1 after the flush; a run that never settles keeps exit code 1 (G3/G4)', async () => {
    const [chunks, exit] = [[] as string[], jest.fn()];
    try {
      await runCli(() => Promise.reject(new Error('S5ASENTINEL')), (chunk, done) => (chunks.push(chunk), done?.()), exit);
      expect([chunks, exit.mock.calls, process.exitCode]).toEqual([['migrate-legacy-discovery-definitions: failed (unexpected)\n', ''], [[1]], 1]);
      process.exitCode = 0;
      void runCli(() => Promise.withResolvers<number>().promise, () => undefined, exit);
      await new Promise(setImmediate);
      expect([process.exitCode, exit.mock.calls.length]).toEqual([1, 1]);
    } finally {
      process.exitCode = undefined;
    }
  });
});
