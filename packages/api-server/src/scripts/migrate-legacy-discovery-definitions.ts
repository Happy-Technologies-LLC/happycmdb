// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-774 S5a (design §3.2, §3.4): classifies every legacy discovery_definitions row, NULL-org rows included (R22),
 * and writes a value-free dry-run plan to `--out <path>` only: a new file (O_EXCL, mode 0600), never stdout. SELECT only;
 * nothing else is written. There is no apply here (S5b), so any other argument, --apply included, exits 1 before a
 * connection opens. A non-loopback, non-socket host needs CMDB_MIGRATION_POSTGRES_SSL=verify-full and a DNS name
 * (refused otherwise, before connecting). Every plan field passes the allow-list encoder (uuid, enum, timestamp, count, key-skeleton and
 * plan digests); anything else exits 2 with no plan. Errors print fixed text plus at most the error name and SQLSTATE.
 * L1d payload equality is compared in memory with the operator-held CREDENTIAL_ENCRYPTION_KEY (§3.5); without it, or
 * on any decode failure, the row stays DUAL_CREDENTIAL_MISMATCH. Connects only through CMDB_MIGRATION_POSTGRES_*.
 */

import { createHash } from 'crypto';
import { closeSync, constants, openSync, unlinkSync, writeFileSync } from 'fs';
import { isIP } from 'net';

// Direct modules, not the @cmdb/database barrel (it opens a Redis connection at load time).
import { getEncryptionService, type EncryptedData } from '../../../common/src/services/encryption.service';
import { hasUnsafeDiscoveryDefinitionConfig } from '../../../common/src/utils/discovery-scan-config';
import { PostgresClient } from '../../../database/src/postgres/client';

// updated_at as a UTC microsecond string: the S5b drift check compares it without Date's millisecond truncation.
export const DEFINITIONS_SQL = `SELECT id, organization_id, provider, credential_id, credential_set_id, created_by, config,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at FROM discovery_definitions ORDER BY id`;
/** Only credentials attached to an L1d candidate; decoded (in memory) only after the org, owner and protocol match. */
export const CREDENTIALS_SQL = 'SELECT id, organization_id, protocol, created_by, credentials FROM credentials WHERE id = ANY($1::uuid[])';

const SHAPES = ['L1', 'L1d', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'SAFE', 'UNKNOWN'] as const;
const DISPOSITIONS = ['CONVERT', 'STRIP_EQUAL', 'LEAVE', 'SKIP'] as const;
const REASONS = ['INLINE_CREDENTIAL', 'ALIAS_RENAME', 'BENIGN_STRIP', 'PAYLOAD_EQUAL', 'ALREADY_SAFE', 'PATH_REFERENCE',
  'TARGET_GRAMMAR', 'DUAL_CREDENTIAL_MISMATCH', 'HETEROGENEOUS_CREDENTIALS', 'NO_CREDENTIAL_MATERIAL', 'UNSUPPORTED_PROVIDER',
  'TARGET_SECRET', 'NMAP_SECRET_NO_CONSUMER', 'MALFORMED', 'NO_VERIFIED_ORG', 'CREDENTIAL_SET_UNSUPPORTED', 'UNRECOGNIZED'] as const;
const PROTOCOLS = ['ssh_password', 'ssh_key'] as const;
/** The DB check's providers plus the seed's rewritten set (`:5-11`); any other stored value prints as OTHER. */
const PROVIDERS = ['ssh', 'nmap', 'active-directory', 'snmp', 'aws', 'azure', 'gcp', 'kubernetes', 'docker', 'hyperv', 'idrac',
  'ilo', 'proxmox', 'vmware', 'activedirectory', 'OTHER'];
type Shape = typeof SHAPES[number];
type Reason = typeof REASONS[number];
type Protocol = typeof PROTOCOLS[number];

export interface DefinitionRow { id: string; organization_id: string | null; provider: string; credential_id: string | null; credential_set_id: string | null; created_by: string; config: unknown; updated_at: string }
export interface StoredCredential { organization_id: string | null; protocol: string; created_by: string; credentials: unknown }
/** Field order is the printed order; the encoder rejects any other key set. */
export interface Classification { shape: Shape; disposition: typeof DISPOSITIONS[number]; reason: Reason; new_credential_protocol: Protocol | null }
export type Decode = (envelope: EncryptedData) => string;

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const onlyKeys = (value: Obj, ...allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const single = (value: Obj): boolean => Object.keys(value).length === 1;
const text = (value: unknown): value is string => typeof value === 'string' && value !== '';
const leave = (shape: Shape, reason: Reason): Classification => ({ shape, disposition: 'LEAVE', reason, new_credential_protocol: null });

/**
 * Frozen-grammar hosts (no CIDR for ssh) after stripping one uniform `:port` when allowed (D16); mixed ports,
 * bracketed IPv6 and any other form fail.
 */
function validHosts(targets: unknown, ssh: boolean, stripPort: boolean): boolean {
  if (!Array.isArray(targets) || targets.length === 0 || !targets.every(text)) {
    return false;
  }
  const ports = new Set(targets.map(target => /^[^:[\]]+:(\d{1,5})$/.exec(target)?.[1]));
  const [port] = ports;
  if (ports.size !== 1 || (port !== undefined && (!stripPort || Number(port) < 1 || Number(port) > 65535))) {
    return false;
  }
  const hosts = port === undefined ? targets : targets.map(target => target.slice(0, target.lastIndexOf(':')));
  return !(ssh && hosts.some(host => host.includes('/'))) && !hasUnsafeDiscoveryDefinitionConfig({ targets: hosts });
}

/** The inline ssh credential kind; a non-PEM privateKey is a worker path (D6). */
function inlineKind(credentials: unknown): Protocol | 'PATH_REFERENCE' | null {
  if (!isObj(credentials) || !text(credentials['username'])) {
    return null;
  }
  const key = credentials['privateKey'];
  if (text(key) && !key.startsWith('-----BEGIN')) {
    return 'PATH_REFERENCE';
  }
  if (onlyKeys(credentials, 'username', 'password') && text(credentials['password'])) {
    return 'ssh_password';
  }
  return onlyKeys(credentials, 'username', 'privateKey') && text(key) ? 'ssh_key' : null;
}

/** L1d: same org, owner and inline kind, and the decoded envelope equals the inline credential exactly (in memory only). */
function storedEquals(row: DefinitionRow, kind: Protocol, inline: Obj, stored?: StoredCredential, decode?: Decode): boolean {
  const envelope = stored?.credentials;
  if (stored === undefined || decode === undefined || stored.organization_id !== row.organization_id || stored.created_by !== row.created_by || stored.protocol !== kind
      || !isObj(envelope) || !onlyKeys(envelope, 'iv', 'encryptedData', 'authTag') || ![envelope['iv'], envelope['encryptedData'], envelope['authTag']].every(text)) {
    return false;
  }
  const expected: Obj = kind === 'ssh_password'
    ? { username: inline['username'], password: inline['password'] }
    : { username: inline['username'], private_key: inline['privateKey'] };
  try {
    const payload: unknown = JSON.parse(decode(envelope as unknown as EncryptedData));
    return isObj(payload) && Object.keys(payload).length === 2 && Object.entries(expected).every(([key, value]) => payload[key] === value);
  } catch {
    return false;
  }
}

/** §3.2: shape-intrinsic LEAVE reasons first; NULL org (D9) and credential sets (D2) then block whatever would convert. */
export function classifyDefinition(row: DefinitionRow, stored: ReadonlyMap<string, StoredCredential>, decode?: Decode): Classification {
  const config = row.config;
  if (!isObj(config)) {
    return leave('L12', 'MALFORMED');
  }
  if (!hasUnsafeDiscoveryDefinitionConfig(config)) {
    return { shape: 'SAFE', disposition: 'SKIP', reason: 'ALREADY_SAFE', new_credential_protocol: null };
  }
  const { provider } = row;
  if (provider !== 'ssh' && provider !== 'nmap') {
    const inline = 'credentials' in config;
    return leave(provider === 'snmp' ? 'L3' : provider === 'active-directory' && inline ? 'L2' : ['aws', 'azure', 'gcp'].includes(provider) && inline ? 'L8' : 'L7', 'UNSUPPORTED_PROVIDER');
  }
  const blocked: Reason | null = row.organization_id === null ? 'NO_VERIFIED_ORG' : row.credential_set_id !== null ? 'CREDENTIAL_SET_UNSUPPORTED' : null;
  const convert = (shape: Shape, reason: Reason, protocol: Protocol | null = null): Classification =>
    blocked !== null ? leave(shape, blocked) : row.credential_id !== null ? leave(shape, 'DUAL_CREDENTIAL_MISMATCH')
      : { shape, disposition: 'CONVERT', reason, new_credential_protocol: protocol };
  const ssh = provider === 'ssh';
  if (ssh && 'credentials' in config) {
    const shape = row.credential_id === null ? 'L1' : 'L1d';
    const kind = inlineKind(config['credentials']);
    if (!onlyKeys(config, 'targets', 'credentials') || kind === null) {
      return leave(shape, 'UNRECOGNIZED');
    }
    if (kind === 'PATH_REFERENCE') {
      return leave(shape, kind);
    }
    // L1d keeps its stored credential, so a port has nowhere to go: no strip.
    if (!validHosts(config['targets'], true, shape === 'L1')) {
      return leave(shape, 'TARGET_GRAMMAR');
    }
    if (shape === 'L1' || blocked !== null) {
      return convert(shape, 'INLINE_CREDENTIAL', kind);
    }
    return storedEquals(row, kind, config['credentials'] as Obj, stored.get(row.credential_id!), decode)
      ? { shape, disposition: 'STRIP_EQUAL', reason: 'PAYLOAD_EQUAL', new_credential_protocol: null }
      : leave(shape, 'DUAL_CREDENTIAL_MISMATCH');
  }
  const inner = isObj(config['_config']) ? config['_config'] : {};
  const list = [config['hosts'], config['_targets'], inner['targets'], inner['hosts']].find(value => Array.isArray(value) && value.some(isObj));
  if (ssh && Array.isArray(list)) {
    const hosts = list as Obj[];
    if (!single(config) || ('_config' in config && !single(inner)) || !list.every(entry => isObj(entry) && onlyKeys(entry, 'host', 'username', 'password', 'privateKeyPath'))) {
      return leave('L10', 'UNRECOGNIZED');
    }
    if (hosts.some(entry => 'privateKeyPath' in entry)) {
      return leave('L10', 'PATH_REFERENCE');
    }
    if (!hosts.every(entry => text(entry['username']) && text(entry['password'])) || new Set(hosts.map(entry => JSON.stringify([entry['username'], entry['password']]))).size !== 1) {
      return leave('L10', 'HETEROGENEOUS_CREDENTIALS');
    }
    return validHosts(hosts.map(entry => entry['host']), true, false) ? convert('L10', 'INLINE_CREDENTIAL', 'ssh_password') : leave('L10', 'TARGET_GRAMMAR');
  }
  const aliased = Array.isArray(config['targets']) ? config['targets'] : config['_targets'];
  const targets: unknown[] = Array.isArray(aliased) ? aliased : typeof config['range'] === 'string' ? [config['range']] : [];
  if (targets.some(target => typeof target === 'string' && target.includes('@'))) {
    if (!ssh) {
      return leave('L11', 'NMAP_SECRET_NO_CONSUMER');
    }
    // A `%` in userinfo is never decoded: literal or percent-encoded is a guess, so the row stays TARGET_SECRET.
    const parsed = targets.map(target => typeof target === 'string' ? /^(?:ssh:\/\/)?([^:@/\s%]+):([^@/\s%]+)@([^@/\s]+)$/.exec(target) : null);
    const exact = single(config) && parsed.every(match => match !== null) && new Set(parsed.map(match => JSON.stringify(match?.slice(1, 3)))).size === 1;
    return exact && validHosts(parsed.map(match => match?.[3]), true, true) ? convert('L11', 'INLINE_CREDENTIAL', 'ssh_password') : leave('L11', 'TARGET_SECRET');
  }
  if (single(config) && Array.isArray(config['_targets'])) {
    return validHosts(config['_targets'], ssh, false) ? convert('L9', 'ALIAS_RENAME') : leave('L9', 'TARGET_GRAMMAR');
  }
  const options = isObj(config['scanOptions']) ? config['scanOptions'] : {};
  if (!ssh && ('ports' in options || 'ports' in config || 'scan_type' in config)) {
    const shape = 'ports' in options ? 'L4' : 'L6';
    const { ports, ...modes } = options;
    // Strips only port lists and a scan-type word; any other key or value shape is not provably benign.
    const benign = onlyKeys(config, 'targets', 'scanOptions', 'ports', 'scan_type') && (config['scanOptions'] === undefined || isObj(config['scanOptions']))
      && [ports, config['ports']].every(value => value === undefined || /^[\d,\s-]{1,256}$/.test(String(value)))
      && (config['scan_type'] === undefined || /^[a-z_-]{1,32}$/i.test(String(config['scan_type']))) && row.credential_id === null;
    if (!benign || hasUnsafeDiscoveryDefinitionConfig({ scanOptions: modes })) {
      return leave(shape, 'UNRECOGNIZED');
    }
    return validHosts(config['targets'], false, false) ? convert(shape, 'BENIGN_STRIP') : leave(shape, 'TARGET_GRAMMAR');
  }
  const numeric = [config['port'], config['timeout']].every(value => value === undefined || (typeof value === 'number' && Number.isFinite(value)));
  if (ssh && onlyKeys(config, 'targets', 'port', 'timeout') && validHosts(config['targets'], false, false) && numeric && row.credential_id === null) {
    return leave('L5', 'NO_CREDENTIAL_MATERIAL');
  }
  return leave('UNKNOWN', 'UNRECOGNIZED');
}

/** No legacy shape nests deeper than 4; a deeper config is MALFORMED rather than a stack risk for one row or the run. */
export const MAX_CONFIG_DEPTH = 32;

/**
 * §3.4 drift skeleton: SHA-256 over the sorted, de-duplicated JSON key paths of config (array elements as 0); never
 * values. Iterative; throws past MAX_CONFIG_DEPTH.
 */
export function keySkeletonSha256(config: unknown): string {
  const paths = new Set<string>();
  const pending: Array<[unknown, ReadonlyArray<string | 0>]> = [[config, []]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [value, path] = next;
    if (path.length > MAX_CONFIG_DEPTH) {
      throw new RangeError();
    }
    if (Array.isArray(value)) {
      value.forEach(item => pending.push([item, [...path, 0]]));
    } else if (isObj(value)) {
      for (const [key, child] of Object.entries(value)) {
        paths.add(JSON.stringify([...path, key]));
        pending.push([child, [...path, key]]);
      }
    }
  }
  return createHash('sha256').update(JSON.stringify([...paths].sort())).digest('hex');
}

/** Carries no message: the rejected value is never echoed. */
export class PlanEncodingError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (value: unknown): boolean => typeof value === 'string' && UUID.test(value);
const oneOf = (values: readonly string[]) => (value: unknown): boolean => typeof value === 'string' && values.includes(value);
/** The only printable row fields, in order, each with its typed check. */
const ROW_FIELDS: ReadonlyArray<[string, (value: unknown) => boolean]> = [
  ['definition_id', isUuid], ['organization_id', value => value === null || isUuid(value)], ['provider', oneOf(PROVIDERS)], ['shape', oneOf(SHAPES)],
  ['disposition', oneOf(DISPOSITIONS)], ['reason', oneOf(REASONS)], ['new_credential_protocol', value => value === null || oneOf(PROTOCOLS)(value)],
  ['updated_at', value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)],
  ['key_skeleton_sha256', value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)],
];
type PlanRow = { definition_id: string; organization_id: string | null; provider: string } & Classification & { updated_at: string; key_skeleton_sha256: string };

/** Allow-list encoder: throws PlanEncodingError (never echoing the value) unless every row is exactly ROW_FIELDS. */
export function encodePlan(rows: readonly unknown[]): string {
  for (const row of rows) {
    if (!isObj(row) || Object.keys(row).join() !== ROW_FIELDS.map(([name]) => name).join() || !ROW_FIELDS.every(([name, valid]) => valid(row[name]))) {
      throw new PlanEncodingError();
    }
  }
  const plan = rows as readonly PlanRow[];
  const tally = (field: 'shape' | 'disposition' | 'reason'): Record<string, number> =>
    plan.reduce<Record<string, number>>((counts, row) => ({ ...counts, [row[field]]: (counts[row[field]] ?? 0) + 1 }), {});
  const body = {
    rows: plan,
    counts: { total: plan.length, null_organization: plan.filter(row => row.organization_id === null).length, by_shape: tally('shape'), by_disposition: tally('disposition'), by_reason: tally('reason') },
  };
  return JSON.stringify({ mode: 'dry-run', ...body, plan_sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex') });
}

export interface SqlClient { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>; close(): Promise<void> }
type PostgresConfig = ConstructorParameters<typeof PostgresClient>[0];
export const openPostgres = (config: PostgresConfig): SqlClient => new PostgresClient(config);

function postgresConfig(env: NodeJS.ProcessEnv): PostgresConfig | null {
  const [host, port, database, user, password, ssl] = ['HOST', 'PORT', 'DB', 'USER', 'PASSWORD', 'SSL'].map(name => env[`CMDB_MIGRATION_POSTGRES_${name}`] ?? '');
  const sslMode = ssl === '' ? false : ssl === 'require' || ssl === 'verify-full' ? ssl : null;
  if (![host, database, user, password].every(text) || !/^\d{1,5}$/.test(port!) || Number(port) < 1 || Number(port) > 65535 || sslMode === null) {
    return null;
  }
  return { _host: host!, _port: Number(port), _database: database!, _user: user!, _password: password!, ssl: sslMode };
}

/** Loopback (127.0.0.0/8, ::1, localhost) or a Unix socket directory: the only hosts allowed without verify-full. */
function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || host.startsWith('/') || (isIP(host) === 4 && host.startsWith('127.'));
}

/** CLI entry: dry run only; returns the exit code. */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: { stderr: (line: string) => void },
  open = openPostgres,
  classify = classifyDefinition
): Promise<number> {
  // Fixed text only: never a row value, a connection setting or an error message.
  const fail = (message: string, code: 1 | 2): number => (io.stderr(`migrate-legacy-discovery-definitions: ${message}`), code);
  const config = postgresConfig(env);
  const out = argv.length === 2 && argv[0] === '--out' && text(argv[1]) && !argv[1].startsWith('--') ? argv[1] : null;
  if (out === null || config === null) {
    return fail('usage: CMDB_MIGRATION_POSTGRES_{HOST,PORT,DB,USER,PASSWORD}=<...> [CMDB_MIGRATION_POSTGRES_SSL=require|verify-full] migrate-legacy-discovery-definitions --out <new plan file> (dry run only)', 1);
  }
  // PostgresClient maps verify-full to rejectUnauthorized:true (chain and host name); unset is cleartext and require does not verify.
  if (config.ssl !== 'verify-full' && !isLocalHost(config._host)) {
    return fail('refused: a non-loopback host needs CMDB_MIGRATION_POSTGRES_SSL=verify-full', 1);
  }
  // pg sets the TLS servername only for DNS names; for an IP literal Node checks the certificate against 'localhost'.
  if (config.ssl === 'verify-full' && isIP(config._host) !== 0 && !isLocalHost(config._host)) {
    return fail('refused: verify-full needs a DNS host name, not an IP literal', 1);
  }
  let fd: number;
  try {
    fd = openSync(out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch {
    return fail('refused: --out must be a new file', 1);
  }
  let client: SqlClient | undefined;
  let written = false;
  try {
    client = open(config);
    const rows = (await client.query(DEFINITIONS_SQL)).rows as unknown as DefinitionRow[];
    const ids = rows.filter(row => row.credential_id !== null && isObj(row.config) && 'credentials' in row.config).map(row => row.credential_id);
    const stored = new Map((await client.query(CREDENTIALS_SQL, [ids])).rows.map(row => [row['id'] as string, row as unknown as StoredCredential]));
    // The service throws only for an absent or short key; then nothing is proven and L1d rows stay DUAL_CREDENTIAL_MISMATCH.
    const key = env['CREDENTIAL_ENCRYPTION_KEY'] ?? '';
    const service = key.length >= 32 ? getEncryptionService(key) : undefined;
    const decode: Decode | undefined = service === undefined ? undefined : envelope => service.decrypt(envelope);
    const planRow = (row: DefinitionRow): Record<string, unknown> => {
      const base = { definition_id: row.id, organization_id: row.organization_id, provider: PROVIDERS.includes(row.provider) ? row.provider : 'OTHER' };
      try {
        // Skeleton first: its depth cap also bounds the classifier's own traversals of this row.
        const key_skeleton_sha256 = keySkeletonSha256(row.config);
        return { ...base, ...classify(row, stored, decode), updated_at: row.updated_at, key_skeleton_sha256 };
      } catch {
        // One pathological row is MALFORMED (R17); it never aborts the plan for every other row.
        return { ...base, ...leave('L12', 'MALFORMED'), updated_at: row.updated_at, key_skeleton_sha256: keySkeletonSha256(null) };
      }
    };
    writeFileSync(fd, `${encodePlan(rows.map(planRow))}\n`);
    written = true;
    return 0;
  } catch (error) {
    if (error instanceof PlanEncodingError) {
      return fail('refused: a plan field failed the value-free encoder', 2);
    }
    const name = error instanceof Error && /^[A-Za-z]\w{0,63}$/.test(error.name) ? error.name : 'unknown';
    const code = (error as { code?: unknown } | null)?.code;
    return fail(`failed (${name}${typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `, ${code}` : ''})`, 1);
  } finally {
    await client?.close().catch(() => undefined);
    try {
      closeSync(fd);
      if (!written) {
        unlinkSync(out); // this run created it: no partial or empty plan survives a failure
      }
    } catch {
      // Already gone: no plan remains, and the fixed-text result above stands (never an ENOENT with the path).
    }
  }
}

/** Exits only once the output stream has flushed: a slow piped reader must not lose the tail of it. */
export function exitAfterFlush(code: number, write: (chunk: string, done: () => void) => unknown, exit: (code: number) => void): void {
  process.exitCode = code;
  write('', () => exit(code));
}

if (require.main === module) {
  // Nothing goes to stdout: every stdout write (the shared logger, libraries) goes to stderr.
  process.stdout.write = process.stderr.write.bind(process.stderr);
  // PostgresClient also reads the api-server's TLS toggles; this tool is configured only by CMDB_MIGRATION_POSTGRES_*.
  delete process.env['POSTGRES_SSL_MODE'];
  delete process.env['POSTGRES_SSL_ENABLED'];
  void main(process.argv.slice(2), process.env, { stderr: line => process.stderr.write(`${line}\n`) })
    .catch(() => (process.stderr.write('migrate-legacy-discovery-definitions: failed (unexpected)\n'), 1))
    .then(code => exitAfterFlush(code, (chunk, done) => process.stderr.write(chunk, done), exitCode => process.exit(exitCode)));
}
