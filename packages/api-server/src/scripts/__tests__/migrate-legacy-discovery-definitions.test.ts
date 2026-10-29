// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-774 S5a: the legacy discovery-definition classifier runs against PGlite (the discovery_definitions and
 * credentials blocks of 001_complete_schema.sql, 024's organization column, 021's credential organization column and
 * the seed's provider-check drop). Every secret, name and target carries the S5ASENTINEL marker.
 */

import { fork } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

import { getEncryptionService } from '../../../../common/src/services/encryption.service';
import { main, type SqlClient } from '../migrate-legacy-discovery-definitions';

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
const ENV = { CMDB_MIGRATION_POSTGRES_HOST: 'h', CMDB_MIGRATION_POSTGRES_PORT: '5432', CMDB_MIGRATION_POSTGRES_DB: 'd', CMDB_MIGRATION_POSTGRES_USER: 'u', CMDB_MIGRATION_POSTGRES_PASSWORD: 'S5ASENTINEL-DBPW' };
const [ORG, ORG_B, OWNER] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 's5asentinel-owner'];
const [U, PW] = ['s5asentinel-user', 'S5ASENTINEL-PW-1'];
const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nS5ASENTINEL-KEY\n-----END OPENSSH PRIVATE KEY-----';
const H = (n: number) => `s5asentinel-h${n}.example`;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PASSWORD = { username: U, password: PW };
// Stored credentials for the L1d rows: [id, org, owner, protocol, decoded payload].
const CREDENTIALS: Array<[number, string, string, string, object]> = [
  [90, ORG, OWNER, 'ssh_password', PASSWORD], [91, ORG, OWNER, 'ssh_password', { ...PASSWORD, password: 'S5ASENTINEL-PW-2' }],
  [92, ORG, OWNER, 'ssh_key', PASSWORD], [93, ORG_B, OWNER, 'ssh_password', PASSWORD], [94, ORG, 's5asentinel-other', 'ssh_password', PASSWORD],
];
const ssh = (targets: string[], credentials: object = PASSWORD) => ({ targets, credentials });
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
];
const LITERALS = ['192.168.1.0', '10.0.0.0', 'us-east-1', 'dc=', 'BEGIN OPENSSH', '2001:db8'];

async function run(argv: string[] = [], env: NodeJS.ProcessEnv = { ...ENV, CREDENTIAL_ENCRYPTION_KEY: KEY }, open = jest.fn(() => client), classify?: Parameters<typeof main>[4]) {
  const out: string[] = [], err: string[] = [];
  queries.length = 0;
  const code = await main(argv, env, { stdout: line => out.push(line), stderr: line => err.push(line) }, open, classify);
  return { code, out: out.join('\n'), err: err.join('\n'), open };
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
  for (const [n, org, owner, protocol, payload] of CREDENTIALS) {
    await send('query', `INSERT INTO credentials (id, name, protocol, scope, credentials, created_by, organization_id) VALUES ($1, 's5asentinel-cred', $2, 'ssh', $3, $4, $5)`,
      [uuid(n), protocol, JSON.stringify(service.encrypt(JSON.stringify(payload))), owner, org]);
  }
  for (const [index, [name, provider, org, credential, set, config]] of FIXTURES.entries()) {
    await send('query', `INSERT INTO discovery_definitions (id, name, provider, credential_id, credential_set_id, created_by, organization_id, config) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [uuid(index + 1), `S5ASENTINEL-NAME ${name}`, provider, credential && uuid(credential), set && uuid(set), OWNER, org, JSON.stringify(config)]);
  }
});
afterAll(() => host.kill());

describe('migrate-legacy-discovery-definitions (dry run, PGlite)', () => {
  it('classifies every row, NULL org included, with the exact §3.2 disposition and reason, and digests the plan', async () => {
    const { code, out } = await run();
    expect(code).toBe(0);
    const plan = JSON.parse(out);
    expect(plan.rows).toEqual(FIXTURES.map(([, , org, , , , expected], index) => {
      const [shape, disposition, reason, protocol = 'null'] = expected.split(' ');
      return { definition_id: uuid(index + 1), organization_id: org, shape, disposition, reason, new_credential_protocol: protocol === 'null' ? null : protocol };
    }));
    expect(plan.counts.null_organization).toBe(4);
    expect(plan.plan_sha256).toBe(createHash('sha256').update(JSON.stringify({ rows: plan.rows, counts: plan.counts })).digest('hex'));
  });

  it('issues only SELECT statements', async () => {
    expect((await run()).code).toBe(0);
    expect(queries.length).toBeGreaterThan(0);
    for (const sql of queries) expect(sql).toMatch(/^SELECT [^;]*$/);
  });

  it('never prints a marker, name, target, credential or decoded payload', async () => {
    const { code, out, err } = await run();
    expect(code).toBe(0);
    expectValueFree(`${out}\n${err}`);
  });

  it('without the encryption key an equal L1d payload is unproven: DUAL_CREDENTIAL_MISMATCH', async () => {
    const { code, out } = await run([], ENV);
    expect(code).toBe(0);
    expect(JSON.parse(out).rows[5]).toMatchObject({ shape: 'L1d', disposition: 'LEAVE', reason: 'DUAL_CREDENTIAL_MISMATCH' });
  });

  it('the allow-list encoder aborts with exit 2 and prints nothing of an injected field or free-text value', async () => {
    const injections = [{ name: 'S5ASENTINEL-INJECTED' }, { reason: 'S5ASENTINEL free text' }];
    for (const injection of injections) {
      const { code, out, err } = await run([], undefined, undefined, () => ({ shape: 'L1', disposition: 'LEAVE', reason: 'MALFORMED', new_credential_protocol: null, ...injection }) as never);
      expect([code, out]).toEqual([2, '']);
      expectValueFree(err);
    }
  });

  it('refuses --apply, unknown or valueless flags and missing settings with exit 1 before any connection', async () => {
    for (const [argv, env] of [[['--apply']], [['--plan', 'p', '--sha256', 'a'.repeat(64)]], [['--bogus']], [['--organization-id']], [[], { ...ENV, CMDB_MIGRATION_POSTGRES_PORT: 'x' }]] as Array<[string[], NodeJS.ProcessEnv?]>) {
      const { code, out, open } = await run(argv, env);
      expect([code, out]).toEqual([1, '']);
      expect(open).not.toHaveBeenCalled();
    }
  });

  it('a connection failure prints fixed text with the error name and SQLSTATE only', async () => {
    const failing: SqlClient = { query: async () => { throw Object.assign(new Error(`password authentication failed for user u at postgres://u:${ENV.CMDB_MIGRATION_POSTGRES_PASSWORD}@h`), { code: '28P01' }); }, close: async () => undefined };
    const { code, out, err } = await run([], undefined, jest.fn(() => failing));
    expect([code, out, err]).toEqual([1, '', 'migrate-legacy-discovery-definitions: failed (Error, 28P01)']);
  });
});
