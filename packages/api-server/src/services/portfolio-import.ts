// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1426 (PoR S5, design brief §5): the HappyHive catalog-as-portfolio export, parsed and validated with no I/O.
 *
 * The file is JSONL: a header on line 1, then one service, ci, relationship or service_ci record per line. Each line
 * becomes a typed record of allow-listed fields or a `{line, code}` rejection. A rejected line's content is dropped
 * here: no response, log or audit row ever carries it (a line holding a credential-like key is `forbidden_key`).
 * Unknown keys on an accepted line are ignored, never stored.
 */

import { assertNoReservedMembers, assertRequestShape } from '../journal-http';

export const IMPORT_SOURCE = 'happyhive';
export const IMPORT_KINDS = ['service', 'ci', 'relationship', 'service_ci'] as const;
export type ImportKind = typeof IMPORT_KINDS[number];
export type RejectCode = 'invalid_json' | 'invalid_shape' | 'forbidden_key' | 'unknown_kind' | 'missing_field'
  | 'invalid_field' | 'duplicate_source_id' | 'unknown_reference';
export interface Rejection { line: number; code: RejectCode }
/** A value HappyCMDB chose because the export had none it can store (plan ruling D3: never silent). */
export interface Defaulted { field: string; value: string; reason: string }

export const SERVICE_STATUSES = ['draft', 'review', 'active', 'deprecated', 'retired'] as const;
export const CI_ITEM_TYPES = ['server', 'database', 'application', 'network_device', 'storage', 'virtual_machine',
  'container', 'service', 'endpoint', 'agent', 'tool', 'model', 'data_source', 'integration', 'other'] as const;
const CI_STATUSES = ['active', 'deprecated', 'retired'] as const;
/** HappyHive relationship_type -> HappyCMDB relationship label, edge direction source -> target (plan ruling D6). */
export const RELATIONSHIP_LABELS = {
  depends_on: 'DEPENDS_ON', used_by: 'USES', communicates_with: 'CONNECTS_TO', version_of: 'PART_OF',
} as const;

export interface ServiceRecord {
  kind: 'service'; line: number; source_id: string; name: string; description: string | null;
  offering_description: string | null; service_type: string | null; status: typeof SERVICE_STATUSES[number];
  owner: string | null; support_group: string | null; expected_sla_hours: number | null; category: string | null;
  tags: string[];
}
export interface CIRecord {
  kind: 'ci'; line: number; source_id: string; item_type: typeof CI_ITEM_TYPES[number]; name: string;
  status: typeof CI_STATUSES[number]; environment: string | null;
  /** Values the parser chose (a missing status is `active`, D3). */
  defaulted: Defaulted[];
  /** The allow-listed descriptive fields, stored as the CI's metadata. */
  details: Record<string, unknown>;
}
export interface RelationshipRecord {
  kind: 'relationship'; line: number; source_id: string; source_ci: string; target_ci: string;
  relationship_type: keyof typeof RELATIONSHIP_LABELS;
}
/** `source_id` is `<service_source_id>/<ci_source_id>` (a source id never contains `/`). */
export interface ServiceCIRecord {
  kind: 'service_ci'; line: number; source_id: string; service_source_id: string; ci_source_id: string;
}
export type ImportRecord = ServiceRecord | CIRecord | RelationshipRecord | ServiceCIRecord;

export interface ImportHeader { organization_id: string; exported_at: string; row_counts: Record<ImportKind, number> }
export interface ParsedImport {
  header: ImportHeader;
  records: ImportRecord[];
  rejected: Rejection[];
  /** Header row_counts equal the lines of each kind (rejected lines of a known kind included). */
  countsMatch: boolean;
}

/** Most record lines one file may hold: each costs reads and a journaled write, so a file is a bounded amount of work. */
export const MAX_IMPORT_RECORDS = 5_000;

/** The whole file is refused (400 malformed header, 413 too many lines, 422 another tenant's export); nothing is planned. */
export class ImportFileError extends Error {
  constructor(readonly status: 400 | 413 | 422, readonly code: 'invalid_header' | 'too_many_lines' | 'tenant_mismatch') {
    super(code);
    this.name = 'ImportFileError';
  }
}

class LineRejected extends Error {
  constructor(readonly code: RejectCode) {
    super(code);
  }
}

/** Credential-like or free-form blob keys (the HappyHive configuration/metadata columns), at any depth. */
const FORBIDDEN_KEY = new RegExp(['password', 'passwd', 'passphrase', '(^|[_.-])pass($|[_.-])', 'pwd', 'secret', 'token',
  'api[_-]?key', 'access[_-]?key', 'private[_-]?key', 'ssh[_-]?key', 'credential', 'authorization', 'bearer', 'cookie',
  'session', 'jwt', 'pem', 'keytab', 'kubeconfig', 'community', 'dsn', 'connection[_-]?string'].join('|'), 'i');
const BLOB_KEYS: Record<string, true> = { configuration: true, metadata: true };
/** HappyHive ids are UUIDs; this also keeps `/` free for the service_ci composite key. */
const SOURCE_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hasForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, member]) =>
    BLOB_KEYS[key.toLowerCase()] === true || FORBIDDEN_KEY.test(key) || hasForbiddenKey(member));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sourceId(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (value === undefined || value === null) throw new LineRejected('missing_field');
  if (typeof value !== 'string' || !SOURCE_ID.test(value)) throw new LineRejected('invalid_field');
  // The import's own Unassigned legacy service: no line may name it, as a record or a reference.
  if (value === UNASSIGNED_LEGACY.source_id) throw new LineRejected('invalid_field');
  return value;
}

/** A trimmed string of at most `max` characters; null when absent or blank unless `required`. */
function text(row: Record<string, unknown>, field: string, max: number, required = false): string | null {
  const value = row[field];
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) throw new LineRejected('missing_field');
    return null;
  }
  if (typeof value !== 'string' || value.trim().length > max) throw new LineRejected('invalid_field');
  return value.trim();
}

function oneOf<T extends string>(row: Record<string, unknown>, field: string, allowed: readonly T[]): T {
  const value = row[field];
  if (value === undefined || value === null) throw new LineRejected('missing_field');
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new LineRejected('invalid_field');
  return value as T;
}

function tags(row: Record<string, unknown>): string[] {
  const value = row['tags'];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) throw new LineRejected('invalid_field');
  return value.map(tag => {
    if (typeof tag !== 'string' || tag.trim() === '' || tag.length > 100) throw new LineRejected('invalid_field');
    return tag.trim();
  });
}

function serviceRecord(row: Record<string, unknown>, line: number): ServiceRecord {
  const sla = row['expected_sla_hours'];
  if (sla !== undefined && sla !== null && !(Number.isInteger(sla) && (sla as number) >= 0 && (sla as number) <= 8760)) {
    throw new LineRejected('invalid_field');
  }
  const short = text(row, 'short_description', 10_000);
  const full = text(row, 'full_description', 10_000);
  return {
    kind: 'service', line, source_id: sourceId(row, 'source_id'), name: text(row, 'name', 255, true)!,
    description: short ?? full, offering_description: full ?? short, service_type: text(row, 'service_type', 50),
    status: oneOf(row, 'status', SERVICE_STATUSES), owner: text(row, 'owner_id', 255),
    support_group: text(row, 'support_group', 255), expected_sla_hours: (sla as number | null | undefined) ?? null,
    category: text(row, 'category_name', 100), tags: tags(row),
  };
}

function ciRecord(row: Record<string, unknown>, line: number): CIRecord {
  const attributes = row['attributes'];
  if (attributes !== undefined && attributes !== null && !isPlainObject(attributes)) throw new LineRejected('invalid_field');
  // The same reserved members (organization_id, _id, ...) every other CI metadata write refuses.
  try {
    assertNoReservedMembers(attributes);
  } catch {
    throw new LineRejected('invalid_field');
  }
  const details: Record<string, unknown> = {};
  for (const [field, max] of [['description', 10_000], ['version', 50], ['owner', 255], ['hostname', 255],
    ['ip_address', 45], ['vendor', 100], ['support_group', 255]] as const) {
    const value = text(row, field, max);
    if (value !== null) details[field] = value;
  }
  if (attributes && Object.keys(attributes).length) details['attributes'] = attributes;
  const ciTags = tags(row);
  if (ciTags.length) details['tags'] = ciTags;
  // The journal stores the CI's metadata as one string value of at most PLAN_LIMITS.valueBytes (64 KiB, JSON-escaped);
  // 512 bytes are left for the source keys the import adds. A larger line is rejected here, not mid-apply.
  if (Buffer.byteLength(JSON.stringify(JSON.stringify(details))) > 65_536 - 512) throw new LineRejected('invalid_field');
  const statusMissing = row['status'] === undefined || row['status'] === null;
  return {
    kind: 'ci', line, source_id: sourceId(row, 'source_id'), item_type: oneOf(row, 'item_type', CI_ITEM_TYPES),
    name: text(row, 'name', 255, true)!, status: statusMissing ? 'active' : oneOf(row, 'status', CI_STATUSES),
    environment: text(row, 'environment', 50), details,
    defaulted: statusMissing ? [{ field: 'status', value: 'active', reason: 'status_defaulted' }] : [],
  };
}

function relationshipRecord(row: Record<string, unknown>, line: number): RelationshipRecord {
  const record: RelationshipRecord = {
    kind: 'relationship', line, source_id: sourceId(row, 'source_id'), source_ci: sourceId(row, 'source_ci'),
    target_ci: sourceId(row, 'target_ci'),
    relationship_type: oneOf(row, 'relationship_type', Object.keys(RELATIONSHIP_LABELS) as Array<keyof typeof RELATIONSHIP_LABELS>),
  };
  if (record.source_ci === record.target_ci) throw new LineRejected('invalid_field');
  return record;
}

function serviceCIRecord(row: Record<string, unknown>, line: number): ServiceCIRecord {
  const service = sourceId(row, 'service_source_id');
  const ci = sourceId(row, 'ci_source_id');
  return { kind: 'service_ci', line, source_id: `${service}/${ci}`, service_source_id: service, ci_source_id: ci };
}

const RECORD_PARSERS: Record<ImportKind, (row: Record<string, unknown>, line: number) => ImportRecord> = {
  service: serviceRecord, ci: ciRecord, relationship: relationshipRecord, service_ci: serviceCIRecord,
};

function parseHeader(raw: string | undefined, organizationId: string): ImportHeader {
  let header: unknown;
  try {
    header = JSON.parse(raw ?? '');
    assertRequestShape(header);
  } catch {
    throw new ImportFileError(400, 'invalid_header');
  }
  if (!isPlainObject(header) || header['kind'] !== 'header' || header['source_system'] !== IMPORT_SOURCE
    || typeof header['organization_id'] !== 'string' || !UUID.test(header['organization_id'])
    || typeof header['exported_at'] !== 'string' || Number.isNaN(Date.parse(header['exported_at']))
    || !isPlainObject(header['row_counts']) || hasForbiddenKey(header)) {
    throw new ImportFileError(400, 'invalid_header');
  }
  const counts = header['row_counts'];
  const rowCounts = {} as Record<ImportKind, number>;
  for (const kind of IMPORT_KINDS) {
    const count = counts[kind];
    if (!Number.isInteger(count) || (count as number) < 0) throw new ImportFileError(400, 'invalid_header');
    rowCounts[kind] = count as number;
  }
  if (header['organization_id'].toLowerCase() !== organizationId.toLowerCase()) {
    throw new ImportFileError(422, 'tenant_mismatch');
  }
  return { organization_id: header['organization_id'], exported_at: header['exported_at'], row_counts: rowCounts };
}

/**
 * Header first (ImportFileError when the file has too many lines, or its header is malformed or names another tenant),
 * then every line in order: a record,
 * or a rejection by 1-based line number. A second record of the same kind and source id is `duplicate_source_id`.
 */
export function parseImport(body: string, organizationId: string): ParsedImport {
  const lines = body.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length - 1 > MAX_IMPORT_RECORDS) throw new ImportFileError(413, 'too_many_lines');
  const header = parseHeader(lines[0], organizationId);
  const records: ImportRecord[] = [];
  const rejected: Rejection[] = [];
  const seen = new Set<string>();
  const counted: Record<ImportKind, number> = { service: 0, ci: 0, relationship: 0, service_ci: 0 };
  lines.slice(1).forEach((raw, index) => {
    const line = index + 2;
    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch {
      rejected.push({ line, code: 'invalid_json' });
      return;
    }
    const kind = isPlainObject(row) ? row['kind'] : undefined;
    const known = typeof kind === 'string' && (IMPORT_KINDS as readonly string[]).includes(kind);
    if (known) counted[kind as ImportKind] += 1;
    try {
      if (!isPlainObject(row)) throw new LineRejected('invalid_shape');
      try {
        assertRequestShape(row);
      } catch {
        throw new LineRejected('invalid_shape');
      }
      if (hasForbiddenKey(row)) throw new LineRejected('forbidden_key');
      if (!known) throw new LineRejected('unknown_kind');
      const record = RECORD_PARSERS[kind as ImportKind](row, line);
      const key = `${record.kind}\u0000${record.source_id}`;
      if (seen.has(key)) throw new LineRejected('duplicate_source_id');
      seen.add(key);
      records.push(record);
    } catch (error) {
      if (!(error instanceof LineRejected)) throw error;
      rejected.push({ line, code: error.code });
    }
  });
  return {
    header, records, rejected,
    countsMatch: IMPORT_KINDS.every(kind => counted[kind] === header.row_counts[kind]),
  };
}

/**
 * Story scenario 8 (HIVE Q-R4 (a)): the one retired service a tenant's first apply creates, through the service path,
 * for legacy records no service owns. Planned ahead of every file line; its fixed source id is reserved (`sourceId`).
 */
export const UNASSIGNED_LEGACY: Readonly<ServiceRecord> = {
  kind: 'service', line: 0, source_id: 'unassigned-legacy', name: 'Unassigned legacy', description: null,
  offering_description: null, service_type: null, status: 'retired', owner: null, support_group: null,
  expected_sla_hours: null, category: null, tags: [],
};

/** C1 lifecycle of an imported service: live/retiring need an owner principal, which HappyHive has none of (D2). */
export function serviceLifecycle(record: ServiceRecord): { lifecycle: 'planned' | 'retired'; defaulted: Defaulted[] } {
  if (record.status === 'retired') return { lifecycle: 'retired', defaulted: [] };
  const defaulted: Defaulted[] = record.status === 'active' || record.status === 'deprecated'
    ? [{ field: 'lifecycle', value: 'planned', reason: 'lifecycle_needs_owner_principal' }] : [];
  return { lifecycle: 'planned', defaulted };
}

/** The D3 service defaults, every one named. */
export const SERVICE_DEFAULTS: Defaulted[] = [
  { field: 'service_classification', value: 'other_it', reason: 'classification_defaulted' },
  { field: 'tbm_tower', value: 'other_it', reason: 'tbm_tower_defaulted' },
  { field: 'business_criticality', value: 'medium', reason: 'criticality_defaulted' },
];

const CI_ENVIRONMENTS = ['production', 'staging', 'development', 'test'];
/** HappyHive item_type -> HappyCMDB CI type; the rest are skipped with a reason. */
export const CI_TYPES: Partial<Record<CIRecord['item_type'], string>> = {
  server: 'server', database: 'database', application: 'application', network_device: 'network-device',
  storage: 'storage', virtual_machine: 'virtual-machine', container: 'container', service: 'service',
};
const AI_ITEM_TYPES: Partial<Record<CIRecord['item_type'], true>> = { agent: true, tool: true, model: true };

export function ciSkipReason(record: CIRecord): string | null {
  if (CI_TYPES[record.item_type]) return null;
  return AI_ITEM_TYPES[record.item_type] === true ? 'ai_asset_source_owned' : 'unsupported_item_type';
}

/** The stored environment; anything outside HappyCMDB's four is `development`, named (D3). */
export function ciEnvironment(record: CIRecord): { environment: string; defaulted: Defaulted[] } {
  const value = record.environment?.toLowerCase();
  if (value && CI_ENVIRONMENTS.includes(value)) return { environment: value, defaulted: [] };
  return { environment: 'development', defaulted: [{ field: 'environment', value: 'development', reason: 'environment_defaulted' }] };
}

export const CI_STATUS: Record<CIRecord['status'], string> = { active: 'active', deprecated: 'inactive', retired: 'decommissioned' };
export const SERVICE_OPERATIONAL_STATUS: Record<ServiceRecord['status'], string> = {
  draft: 'inactive', review: 'inactive', active: 'active', deprecated: 'active', retired: 'decommissioned',
};
