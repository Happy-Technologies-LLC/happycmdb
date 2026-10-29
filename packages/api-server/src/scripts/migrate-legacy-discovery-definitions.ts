// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-774 S5a (design §3.2, §3.4): classifies every legacy discovery_definitions row, NULL-org rows included (R22),
 * and writes a value-free dry-run plan to `--out <path>` only: a new file (O_EXCL, mode 0600), never stdout. SELECT only;
 * nothing else is written. The S5b write modes, --apply/--retire with a plan and --rollback/--finalize with an apply
 * receipt, need that file's --sha256 and write a value-free receipt the same way. Any other argument exits 1 before a
 * connection opens. A non-loopback, non-socket host needs CMDB_MIGRATION_POSTGRES_SSL=verify-full and a DNS name
 * (refused otherwise, before connecting). Every plan field passes the allow-list encoder (uuid, enum, timestamp, count, key-skeleton and
 * plan digests); anything else exits 2 with no plan. Errors print fixed text plus at most the error name and SQLSTATE.
 * L1d payload equality is compared in memory with the operator-held CREDENTIAL_ENCRYPTION_KEY (§3.5); without it, or
 * on any decode failure, the row stays DUAL_CREDENTIAL_MISMATCH. Connects only through CMDB_MIGRATION_POSTGRES_*.
 */

import { createHash } from 'crypto';
import { closeSync, constants, openSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { isIP } from 'net';

// Direct modules, not the @cmdb/database barrel (it opens a Redis connection at load time).
import { getEncryptionService, type EncryptedData } from '../../../common/src/services/encryption.service';
import { hasUnsafeDiscoveryDefinitionConfig } from '../../../common/src/utils/discovery-scan-config';
import { PostgresClient } from '../../../database/src/postgres/client';

// updated_at as a UTC microsecond string: the S5b drift check compares it without Date's millisecond truncation.
export const DEFINITIONS_SQL = `SELECT id, organization_id, provider, credential_id, credential_set_id, created_by, config,
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at FROM discovery_definitions ORDER BY id`;
const SELECT_DEFINITION = DEFINITIONS_SQL.replace(' ORDER BY id', '');
const utc = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
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
/** Both userinfo halves exclude every URL delimiter (B3): anything else is not one proven credential. */
const USERINFO = /^(?:ssh:\/\/)?([^:@/?#[\]\s%]+):([^:@/?#[\]\s%]+)@([^@/\s]+)$/;
const scanTargets = (config: Obj): unknown[] => [config['targets'], config['_targets'], config['range']].flatMap((value): unknown[] => Array.isArray(value) ? value as unknown[] : value === undefined ? [] : [value]);
const hostObjects = (config: Obj): unknown => {
  const inner = isObj(config['_config']) ? config['_config'] : {};
  return [config['hosts'], config['_targets'], inner['targets'], inner['hosts']].find(value => Array.isArray(value) && value.some(isObj));
};

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
  // An empty privateKey is absent (B10); PEM armour after leading whitespace is key material, never a path (B1).
  const { privateKey: key = '', ...rest } = credentials;
  if (typeof key !== 'string' || (key !== '' && !key.trimStart().startsWith('-----BEGIN'))) {
    return typeof key === 'string' && single(rest) && !key.includes('-----BEGIN') ? 'PATH_REFERENCE' : null; // exactly {username, privateKey}
  }
  if (key === '' && onlyKeys(rest, 'username', 'password') && text(rest['password'])) {
    return 'ssh_password';
  }
  return key !== '' && onlyKeys(rest, 'username', 'passphrase') && (rest['passphrase'] === undefined || text(rest['passphrase'])) ? 'ssh_key' : null;
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
    : { username: inline['username'], private_key: inline['privateKey'], ...(inline['passphrase'] === undefined ? {} : { passphrase: inline['passphrase'] }) };
  try {
    const payload: unknown = JSON.parse(decode(envelope as unknown as EncryptedData));
    return isObj(payload) && Object.keys(payload).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => payload[key] === value);
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
    // Inline credentials elsewhere are secret-bearing: their own shape, else UNRECOGNIZED, never the benign L7 (B4).
    const shape = provider === 'snmp' ? 'L3' : !inline ? 'L7' : provider.replace('-', '') === 'activedirectory' ? 'L2' : ['aws', 'azure', 'gcp'].includes(provider) ? 'L8' : null;
    return shape === null ? leave('UNKNOWN', 'UNRECOGNIZED') : leave(shape, 'UNSUPPORTED_PROVIDER');
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
  const list = hostObjects(config);
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
  const targets = scanTargets(config); // every alias at once (B9)
  if (targets.some(target => typeof target === 'string' && target.includes('@'))) {
    if (!ssh) {
      return leave('L11', 'NMAP_SECRET_NO_CONSUMER');
    }
    // A `%` in userinfo is never decoded: literal or percent-encoded is a guess, so the row stays TARGET_SECRET.
    const parsed = targets.map(target => typeof target === 'string' ? USERINFO.exec(target) : null);
    const exact = single(config) && parsed.every(match => match !== null) && new Set(parsed.map(match => JSON.stringify(match?.slice(1, 3)))).size === 1;
    return exact && validHosts(parsed.map(match => match?.[3]), true, true) ? convert('L11', 'INLINE_CREDENTIAL', 'ssh_password') : leave('L11', 'TARGET_SECRET');
  }
  if (single(config) && Array.isArray(config['_targets'])) {
    return !config['_targets'].every(target => typeof target === 'string') ? leave('L9', 'UNRECOGNIZED') // B2
      : validHosts(config['_targets'], ssh, false) ? convert('L9', 'ALIAS_RENAME') : leave('L9', 'TARGET_GRAMMAR');
  }
  const options = isObj(config['scanOptions']) ? config['scanOptions'] : {};
  if (!ssh && ('ports' in options || 'ports' in config || 'scan_type' in config)) {
    const shape = 'ports' in options ? 'L4' : 'L6';
    const { ports, ...modes } = options;
    // Strips only port lists and a scan-type word; any other key or value shape is not provably benign.
    const benign = onlyKeys(config, 'targets', 'scanOptions', 'ports', 'scan_type') && (config['scanOptions'] === undefined || isObj(config['scanOptions']))
      && [ports, config['ports']].every(value => value === undefined || /^[\d,\s-]{1,256}$/.test(String(value)))
      && (config['scan_type'] === undefined || /^[a-z_-]{1,32}$/i.test(String(config['scan_type']))) && row.credential_id === null
      && (!Array.isArray(config['targets']) || config['targets'].every(target => typeof target === 'string'));
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

/** transaction: BEGIN, work, COMMIT on one pinned connection; ROLLBACK and rethrow on any error (PostgresClient.transaction). */
export interface SqlClient { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>; close(): Promise<void>; transaction<T>(work: (tx: Pick<SqlClient, 'query'>) => Promise<T>): Promise<T> }
type PostgresConfig = ConstructorParameters<typeof PostgresClient>[0];
export const openPostgres = (config: PostgresConfig): SqlClient => new PostgresClient(config);

/** Ledger actions (041), plus the receipt-only finalized, refused (a rollback precondition failed) and failed (rolled back). */
const ACTIONS = ['planned_leave', 'converted', 'strip_equal', 'alias_rename', 'benign_strip', 'retired', 'rolled_back', 'drifted', 'finalized', 'refused', 'failed'] as const;
type Action = typeof ACTIONS[number];
type ReceiptRow = { definition_id: string; action: Action };
/** The ledger action of an applied plan row, by its reason. */
const APPLIED: Readonly<Record<string, Action>> = { INLINE_CREDENTIAL: 'converted', PAYLOAD_EQUAL: 'strip_equal', ALIAS_RENAME: 'alias_rename', BENIGN_STRIP: 'benign_strip' };
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** Allow-list encoder of a write mode's receipt: throws PlanEncodingError unless every field is a uuid, digest, enum or count. */
export function encodeReceipt(mode: string, receiptId: unknown, sourceSha256: unknown, rows: readonly unknown[]): string {
  if (!['apply', 'retire', 'rollback', 'finalize'].includes(mode) || !isUuid(receiptId) || !isSha256(sourceSha256) || !Array.isArray(rows)
      || !rows.every(row => isObj(row) && Object.keys(row).join() === 'definition_id,action' && isUuid(row['definition_id']) && oneOf(ACTIONS)(row['action']))) {
    throw new PlanEncodingError();
  }
  const counts = (rows as ReceiptRow[]).reduce<Record<string, number>>((tally, row) => ({ ...tally, [row.action]: (tally[row.action] ?? 0) + 1 }), {});
  const body = { mode, receipt_id: receiptId, source_sha256: sourceSha256, rows, counts };
  return JSON.stringify({ ...body, receipt_sha256: sha256(JSON.stringify(body)) });
}

type Mode = 'dry-run' | 'apply' | 'retire' | 'rollback' | 'finalize';
type SignedInput = { rows: unknown[]; receipt_id?: unknown; source_sha256?: unknown };
/** The --plan/--receipt file only if its bytes hash to --sha256, re-encode byte-exact as this tool's output and list each id once.
 * A retire plan is an operator-filtered subset of dry-run rows, `{"mode":"retire","rows":[…]}`, every row LEAVE (D8). */
function signedInput(mode: Exclude<Mode, 'dry-run'>, path: string, sha: string): SignedInput | null {
  try {
    const bytes = readFileSync(path);
    const doc = JSON.parse(bytes.toString('utf8')) as SignedInput;
    const rows = doc.rows as PlanRow[];
    const encoded = mode === 'apply' ? encodePlan(rows) : mode !== 'retire' ? encodeReceipt('apply', doc.receipt_id, doc.source_sha256, rows)
      : (encodePlan(rows), rows.length > 0 && rows.every(row => row.disposition === 'LEAVE') ? JSON.stringify({ mode: 'retire', rows }) : null);
    return sha256(bytes) === sha && bytes.equals(Buffer.from(`${encoded}\n`)) && new Set(rows.map(row => row.definition_id)).size === rows.length ? doc : null;
  } catch {
    return null;
  }
}

/** Hosts and the one uniform `:port` (D16) of targets the classifier already accepted. */
function splitPort(targets: string[]): [string[], { port?: number }] {
  const port = /^[^:[\]]+:(\d{1,5})$/.exec(targets[0]!)?.[1];
  return port === undefined ? [targets, {}] : [targets.map(target => target.slice(0, target.lastIndexOf(':'))), { port: Number(port) }];
}

/** §3.2 result of a CONVERT or STRIP_EQUAL row: its safe config and the new credential's payload (§3.3), if any. */
export function convertedConfig(config: Obj, row: Classification): { safe: Obj; payload: Obj | null } {
  if (row.shape === 'L1' || row.shape === 'L1d') {
    const [targets, port] = splitPort(config['targets'] as string[]);
    const { username, password, privateKey, passphrase } = config['credentials'] as Obj;
    const secret = row.new_credential_protocol === 'ssh_key' ? { private_key: privateKey, ...(passphrase === undefined ? {} : { passphrase }) } : { password };
    return { safe: { targets }, payload: row.disposition === 'STRIP_EQUAL' ? null : { username, ...secret, ...port } };
  }
  if (row.shape === 'L10') {
    const hosts = hostObjects(config) as Obj[];
    return { safe: { targets: hosts.map(entry => entry['host']) }, payload: { username: hosts[0]!['username'], password: hosts[0]!['password'] } };
  }
  if (row.shape === 'L11') {
    const parsed = scanTargets(config).map(target => USERINFO.exec(target as string)!);
    const [targets, port] = splitPort(parsed.map(match => match[3]!));
    return { safe: { targets }, payload: { username: parsed[0]![1], password: parsed[0]![2], ...port } };
  }
  const modes = { ...(isObj(config['scanOptions']) ? config['scanOptions'] : {}) }; // L9 renames; L4/L6 keep only the boolean modes
  delete modes['ports'];
  return { safe: { targets: config[row.shape === 'L9' ? '_targets' : 'targets'], ...(Object.keys(modes).length > 0 ? { scanOptions: modes } : {}) }, payload: null };
}

type Tx = Pick<SqlClient, 'query'>;
const LEDGER_SQL = `INSERT INTO discovery_definition_migrations (receipt_id, definition_id, organization_id, action, reason, shape,
  prior_credential_id, created_credential_id, pre_updated_at, post_updated_at, key_skeleton_sha256) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`;
const UPDATE_SQL = `UPDATE discovery_definitions SET config = $2::jsonb, credential_id = $3, updated_at = now() WHERE id = $1 RETURNING ${utc('updated_at')} AS updated_at`;
const RETIRE_SQL = `UPDATE discovery_definitions SET config = '{}'::jsonb, is_active = false, updated_at = now() WHERE id = $1 RETURNING ${utc('updated_at')} AS updated_at`;
// §3.3, R7: a direct insert returning the id only; the deterministic name and idx_credentials_unique_name fail a duplicate closed.
const CREDENTIAL_SQL = `INSERT INTO credentials (name, description, protocol, scope, credentials, tags, created_by, organization_id)
  VALUES ('legacy-discovery-' || $1, 'HAP-774 migrated legacy discovery credential', $2, 'ssh', $3::jsonb, ARRAY['hap-774-migrated'], $4, $5) RETURNING id`;
const ESCROW_SQL = 'INSERT INTO discovery_definition_migration_escrow (definition_id, receipt_id, envelope) VALUES ($1, $2, $3)';
// Rollback needs the post-apply updated_at (µs) still on the row and its escrow (deleted by --finalize).
const ROLLBACK_SQL = `SELECT l.organization_id, l.prior_credential_id, l.created_credential_id, e.envelope, ${utc('l.post_updated_at')} AS post_updated_at
  FROM discovery_definition_migrations l JOIN discovery_definitions d ON d.id = l.definition_id AND d.updated_at = l.post_updated_at JOIN discovery_definition_migration_escrow e
  ON e.definition_id = l.definition_id AND e.receipt_id = l.receipt_id WHERE l.receipt_id = $1 AND l.definition_id = $2 AND l.action = $3 FOR UPDATE OF d, e`;
const UNUSED_CREDENTIAL_SQL = `DELETE FROM credentials c WHERE c.id = $1 AND c.updated_at = c.created_at AND NOT EXISTS (SELECT 1 FROM discovery_definitions WHERE credential_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM credential_sets WHERE c.id = ANY(credential_ids)) AND NOT EXISTS (SELECT 1 FROM connector_configurations WHERE credential_id = c.id)`;

/** One write mode, one transaction per row; returns the receipt and the exit code (1 if any row failed or was refused). */
async function writeMode(mode: Exclude<Mode, 'dry-run'>, sha: string, input: SignedInput, client: SqlClient,
  service: { encrypt(text: string): EncryptedData; decrypt(envelope: EncryptedData): string } | undefined, decode: Decode | undefined, classify: typeof classifyDefinition): Promise<[string, number]> {
  // One receipt id per mode and signed input: a re-run of the same input resumes under the same ledger receipt.
  const h = sha256(`${mode}:${sha}`);
  const receiptId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const rows: ReceiptRow[] = [];
  const each = async (id: string, step: (tx: Tx) => Promise<Action>): Promise<void> => {
    let action: Action = 'failed';
    try {
      // A row this receipt already settled (in an earlier, partial run) is reported from the ledger, never redone.
      action = await client.transaction(async tx => {
        const settled = (await tx.query('SELECT action FROM discovery_definition_migrations WHERE receipt_id = $1 AND definition_id = $2', [receiptId, id])).rows[0];
        return settled === undefined ? step(tx) : settled['action'] as Action;
      });
    } catch {
      // The row rolled back as a whole; re-running the same input retries it.
    }
    rows.push({ definition_id: id, action });
  };
  const ledger = async (tx: Tx, action: Action, id: string, ...values: unknown[]): Promise<Action> => (await tx.query(LEDGER_SQL, [receiptId, id, values[0], action, ...values.slice(1)]), action);
  const planLedger = (tx: Tx, p: PlanRow, action: Action, prior: unknown, created: unknown = null, post: unknown = null): Promise<Action> =>
    ledger(tx, action, p.definition_id, p.organization_id, p.reason, p.shape, prior, created, p.updated_at, post, p.key_skeleton_sha256);
  /** The locked row and its classification only while exactly as planned: same updated_at (µs) and org, still unsafe, and re-planned
   * as the dry run does (the skeleton alone sees neither values nor array cardinality) to the same skeleton and result. */
  const unchanged = async (tx: Tx, p: PlanRow): Promise<[DefinitionRow, Classification] | null> => {
    const row = (await tx.query(`${SELECT_DEFINITION} WHERE id = $1 FOR UPDATE`, [p.definition_id])).rows[0] as unknown as DefinitionRow | undefined;
    if (row === undefined || row.updated_at !== p.updated_at || row.organization_id !== p.organization_id || !hasUnsafeDiscoveryDefinitionConfig(row.config)) {
      return null;
    }
    const stored = new Map(row.credential_id === null ? [] : (await tx.query(CREDENTIALS_SQL, [[row.credential_id]])).rows.map(c => [c['id'] as string, c as unknown as StoredCredential]));
    let now: [string, Classification];
    try {
      now = [keySkeletonSha256(row.config), classify(row, stored, decode)];
    } catch {
      now = [keySkeletonSha256(null), leave('L12', 'MALFORMED')];
    }
    const [skeleton, again] = now;
    return skeleton === p.key_skeleton_sha256 && (['shape', 'disposition', 'reason', 'new_credential_protocol'] as const).every(field => again[field] === p[field]) ? [row, again] : null;
  };
  const seal = (value: unknown): string => JSON.stringify(service!.encrypt(JSON.stringify(value)));
  if (mode === 'apply') {
    for (const p of (input.rows as PlanRow[]).filter(row => row.disposition !== 'SKIP')) {
      await each(p.definition_id, async tx => {
        const locked = await unchanged(tx, p);
        if (locked === null || p.disposition === 'LEAVE') {
          return planLedger(tx, p, locked === null ? 'drifted' : 'planned_leave', locked?.[0].credential_id ?? null);
        }
        const [row, now] = locked;
        const { safe, payload } = convertedConfig(row.config as Obj, now);
        const created = payload === null ? null : (await tx.query(CREDENTIAL_SQL, [row.id, now.new_credential_protocol, seal(payload), row.created_by, row.organization_id])).rows[0]!['id'];
        await tx.query(ESCROW_SQL, [row.id, receiptId, seal(row.config)]);
        const post = (await tx.query(UPDATE_SQL, [row.id, JSON.stringify(safe), created ?? row.credential_id])).rows[0]!['updated_at'];
        // Before commit: the stored config passes the strict write grammar (hasUnsafe is its negation), else the row rolls back.
        if (hasUnsafeDiscoveryDefinitionConfig((await tx.query('SELECT config FROM discovery_definitions WHERE id = $1', [row.id])).rows[0]!['config'])) {
          throw new Error();
        }
        return planLedger(tx, p, APPLIED[p.reason]!, row.credential_id, created, post);
      });
    }
  } else if (mode === 'retire') {
    for (const p of input.rows as PlanRow[]) {
      await each(p.definition_id, async tx => {
        const locked = await unchanged(tx, p);
        return locked === null ? planLedger(tx, p, 'drifted', null)
          : planLedger(tx, p, 'retired', locked[0].credential_id, null, (await tx.query(RETIRE_SQL, [p.definition_id])).rows[0]!['updated_at']);
      });
    }
  } else if (mode === 'rollback') {
    for (const { definition_id: id, action } of (input.rows as ReceiptRow[]).filter(row => Object.values(APPLIED).includes(row.action))) {
      await each(id, async tx => {
        const found = (await tx.query(ROLLBACK_SQL, [input.receipt_id, id, action])).rows[0];
        if (found === undefined) {
          return 'refused';
        }
        // This re-creates the legacy plaintext at rest by design (§3.4); the created credential goes only if unused and unmodified.
        const original = service!.decrypt(JSON.parse(found['envelope'] as string) as EncryptedData);
        const post = (await tx.query(UPDATE_SQL, [id, original, found['prior_credential_id']])).rows[0]!['updated_at'];
        await tx.query('DELETE FROM discovery_definition_migration_escrow WHERE definition_id = $1', [id]);
        if (found['created_credential_id'] !== null) {
          await tx.query(UNUSED_CREDENTIAL_SQL, [found['created_credential_id']]);
        }
        return ledger(tx, 'rolled_back', id, found['organization_id'], null, null, found['prior_credential_id'], found['created_credential_id'], found['post_updated_at'], post, null);
      });
    }
  } else {
    const deleted = (await client.query('DELETE FROM discovery_definition_migration_escrow WHERE receipt_id = $1 RETURNING definition_id', [input.receipt_id])).rows;
    rows.push(...deleted.map(row => ({ definition_id: row['definition_id'] as string, action: 'finalized' as const })).sort((a, b) => a.definition_id.localeCompare(b.definition_id)));
  }
  return [encodeReceipt(mode, receiptId, sha, rows), rows.some(row => row.action === 'failed' || row.action === 'refused') ? 1 : 0];
}

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

/** A close() that never settles must not hold the result hostage (#142 LOW-1). */
export const CLOSE_TIMEOUT_MS = 3000;
const INPUT_FLAG: Readonly<Record<string, string>> = { '--apply': '--plan', '--retire': '--plan', '--rollback': '--receipt', '--finalize': '--receipt' };
const isPath = (value: unknown): value is string => text(value) && !value.startsWith('--');

/** CLI entry: the dry run or one write mode; returns the exit code. */
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
  // `--out P` is the dry run; a write mode is `--apply|--retire --plan F` or `--rollback|--finalize --receipt R`, then `--sha256 H --out P`.
  const write = argv.length === 7 && INPUT_FLAG[argv[0]!] === argv[1] && isPath(argv[2]) && argv[3] === '--sha256' && isSha256(argv[4]) && argv[5] === '--out';
  const mode = (write ? argv[0]!.slice(2) : 'dry-run') as Mode;
  const out = (write || (argv.length === 2 && argv[0] === '--out')) && isPath(argv.at(-1)) ? argv.at(-1)! : null;
  if (out === null || config === null) {
    return fail('usage: CMDB_MIGRATION_POSTGRES_{HOST,PORT,DB,USER,PASSWORD}=<...> [CMDB_MIGRATION_POSTGRES_SSL=require|verify-full] migrate-legacy-discovery-definitions [--apply|--retire --plan <file> | --rollback|--finalize --receipt <file>] [--sha256 <hex>] --out <new file>', 1);
  }
  // PostgresClient maps verify-full to rejectUnauthorized:true (chain and host name); unset is cleartext and require does not verify.
  if (config.ssl !== 'verify-full' && !isLocalHost(config._host)) {
    return fail('refused: a non-loopback host needs CMDB_MIGRATION_POSTGRES_SSL=verify-full', 1);
  }
  // pg sets the TLS servername only for DNS names; for an IP literal Node checks the certificate against 'localhost'.
  if (config.ssl === 'verify-full' && isIP(config._host) !== 0 && !isLocalHost(config._host)) {
    return fail('refused: verify-full needs a DNS host name, not an IP literal', 1);
  }
  // The service throws only for an absent or short key; then nothing is proven and L1d rows stay DUAL_CREDENTIAL_MISMATCH.
  const key = env['CREDENTIAL_ENCRYPTION_KEY'] ?? '';
  const service = key.length >= 32 ? getEncryptionService(key) : undefined;
  let decodeFailures = 0;
  const decode: Decode | undefined = service === undefined ? undefined : envelope => {
    try {
      return service.decrypt(envelope);
    } catch (error) {
      decodeFailures += 1; // B7: a wrong key shows as a count, not as silent mismatches
      throw error;
    }
  };
  if ((mode === 'apply' || mode === 'rollback') && service === undefined) {
    return fail('refused: --apply and --rollback need CREDENTIAL_ENCRYPTION_KEY', 1);
  }
  const signed = mode === 'dry-run' ? null : signedInput(mode, argv[2]!, argv[4]!);
  if (mode !== 'dry-run' && signed === null) {
    return fail('refused: the input does not match --sha256 or is not this tool\'s plan or apply receipt', 1);
  }
  let fd: number;
  try {
    fd = openSync(out, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch {
    return fail('refused: --out must be a new file', 1);
  }
  let client: SqlClient | undefined;
  let written = false;
  // Unlinked even if the run never settles (#142 LOW-1); runCli keeps that exit code non-zero.
  const discard = (): void => {
    try {
      if (!written) {
        unlinkSync(out);
      }
    } catch {
      // Already gone.
    }
  };
  process.once('exit', discard);
  try {
    client = open(config);
    if (signed !== null) {
      const [receipt, code] = await writeMode(mode as Exclude<Mode, 'dry-run'>, argv[4]!, signed, client, service, decode, classify);
      writeFileSync(fd, `${receipt}\n`);
      const opened = fd;
      fd = -1; // closed here, so a close error is a failure (the catch below), never a silent exit 0
      closeSync(opened);
      written = true;
      return code;
    }
    const rows = (await client.query(DEFINITIONS_SQL)).rows as unknown as DefinitionRow[];
    const ids = rows.filter(row => row.credential_id !== null && isObj(row.config) && 'credentials' in row.config).map(row => row.credential_id);
    const stored = new Map((await client.query(CREDENTIALS_SQL, [ids])).rows.map(row => [row['id'] as string, row as unknown as StoredCredential]));
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
    const opened = fd;
    fd = -1;
    closeSync(opened);
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
    if (decodeFailures > 0) {
      io.stderr(`migrate-legacy-discovery-definitions: credential decode failures: ${decodeFailures}`);
    }
    try {
      closeSync(fd);
      if (!written) {
        unlinkSync(out); // this run created it: no partial or empty plan survives a failure
      }
    } catch {
      // Already gone: no plan remains, and the fixed-text result above stands (never an ENOENT with the path).
    }
    discard(); // also when closeSync threw above
    process.removeListener('exit', discard);
    // Last and bounded: the result is settled and --out is gone before close() can hang.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([client?.close().catch(() => undefined), new Promise<void>(resolve => void (timer = setTimeout(resolve, CLOSE_TIMEOUT_MS)))]);
    clearTimeout(timer);
  }
}

/** Exits only once the output stream has flushed: a slow piped reader must not lose the tail of it. */
export function exitAfterFlush(code: number, write: (chunk: string, done: () => void) => unknown, exit: (code: number) => void): void {
  process.exitCode = code;
  write('', () => exit(code));
}

/** CLI wrapper: the exit code stays non-zero unless main resolves 0, even if it never settles; exits after stderr flushes. */
export function runCli(run: () => Promise<number>, stderr: (chunk: string, done?: () => void) => unknown, exit: (code: number) => void): Promise<void> {
  process.exitCode = 1;
  return run().catch(() => (stderr('migrate-legacy-discovery-definitions: failed (unexpected)\n'), 1))
    .then(code => exitAfterFlush(code, (chunk, done) => stderr(chunk, done), exit));
}

if (require.main === module) {
  // Nothing goes to stdout: every stdout write (the shared logger, libraries) goes to stderr.
  process.stdout.write = process.stderr.write.bind(process.stderr);
  // PostgresClient also reads the api-server's TLS toggles; this tool is configured only by CMDB_MIGRATION_POSTGRES_*.
  delete process.env['POSTGRES_SSL_MODE'];
  delete process.env['POSTGRES_SSL_ENABLED'];
  void runCli(() => main(process.argv.slice(2), process.env, { stderr: line => process.stderr.write(`${line}\n`) }),
    (chunk, done) => process.stderr.write(chunk, done), code => process.exit(code));
}
