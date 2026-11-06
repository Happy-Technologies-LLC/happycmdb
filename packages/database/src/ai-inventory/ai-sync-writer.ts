// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1442 (AAI S1): the only writer of the source-owned AI CI classes (design brief §4, A1). Each upsert is one
 * journaled Neo4jClient write (createCI or updateCIProperties) holding SOURCE_OWNED_WRITE, by actor `sync:<stream>`
 * with the explicit actor type `system` (HAP-1608), so it appends exactly one hash-chained audit_log row. The CI id is
 * derived from the organization, class and natural key, so a second write of the same key updates the CI instead of
 * creating another.
 * HAP-1444 (AAI S2): a write whose source fields all equal the stored ones (the stream's as-of stamp aside) is
 * `unchanged` and writes nothing; `link` adds a stream's relationship once, and nothing here deletes.
 */
import { createHash } from 'crypto';
import { isInt } from 'neo4j-driver';
import type { AILifecycle, AuthoritativeSource, CIInput, SourceOwnedCIType } from '@cmdb/common';
import { JournalAbortedError } from '../journal/journal';
import type { Neo4jClient } from '../neo4j/client';
import { SOURCE_OWNED_WRITE } from '../neo4j/source-owned-grant';

export type AISyncStream = 'c4_releases' | 'c8_cells' | 'c8_admissions';
export type AIAttributeValue = string | number | boolean | null | readonly string[];

export interface AICIWrite {
  class: SourceOwnedCIType;
  name: string;
  lifecycle?: AILifecycle;
  /** Source fields stored as top-level CI properties; the class's natural key fields are required. */
  attributes: Record<string, AIAttributeValue>;
  /** Source fields written only when the CI is created (e.g. ai-model first_seen_release). */
  createOnly?: Record<string, AIAttributeValue>;
}

/**
 * Which classes a stream writes, the source of record it speaks for, the relationships it may add and the as-of
 * attribute an unchanged comparison ignores (a newer source read of the same data is not a change).
 */
const STREAMS: Record<AISyncStream, { source: AuthoritativeSource; classes: readonly SourceOwnedCIType[];
  links: readonly { type: string; from: SourceOwnedCIType; to: SourceOwnedCIType }[]; asOf?: string }> = {
  c4_releases: { source: 'happylab-c4', classes: ['agent-release', 'ai-model'], asOf: 'c4_as_of',
    links: [{ type: 'USES', from: 'agent-release', to: 'ai-model' }] },
  c8_cells: { source: 'hivecell-c8', classes: ['cell'], links: [] },
  c8_admissions: { source: 'hivecell-c8', classes: ['ai-deployment'], links: [] },
};

/** Natural key fields per class (brief §4): one CI per key per organization. */
const NATURAL_KEYS: Record<SourceOwnedCIType, readonly string[]> = {
  'agent-release': ['release_digest'],
  'ai-model': ['model_id', 'profile'],
  'cell': ['cell_id'],
  'ai-deployment': ['cell_id', 'release_digest'],
};

/** Properties the writer or createCI owns; a source attribute may not set them. */
const RESERVED: readonly string[] = ['id', 'organization_id', 'type', 'ci_type', 'name', 'status', 'environment', 'metadata',
  'external_id', 'incarnation_id', 'created_at', 'updated_at', 'discovered_at', 'discovery_provider', 'authoritative_source',
  'lifecycle', 'op_id', 'reconciliation_op_id', 'organizationid'];
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export class AISyncWriteRefused extends Error {
  constructor(reason: string) {
    super(`AI sync write refused: ${reason}`);
    this.name = 'AISyncWriteRefused';
  }
}

function storableAttributes(attributes: Record<string, AIAttributeValue>): Record<string, AIAttributeValue> {
  for (const [field, value] of Object.entries(attributes)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(field) || RESERVED.includes(field)) throw new AISyncWriteRefused(`attribute ${field}`);
    const text = (v: unknown) => typeof v === 'string' && v.length <= 4096;
    const storable = value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
      || text(value) || (Array.isArray(value) && value.length <= 256 && value.every(text));
    if (!storable) throw new AISyncWriteRefused(`attribute ${field} value`);
  }
  return attributes;
}

function validatedProperties(stream: AISyncStream, write: AICIWrite): { key: string[]; properties: Record<string, AIAttributeValue> } {
  const route = Object.hasOwn(STREAMS, stream) ? STREAMS[stream] : undefined;
  if (!route?.classes.includes(write.class)) throw new AISyncWriteRefused(`stream ${String(stream)} does not write ${String(write.class)}`);
  if (typeof write.name !== 'string' || !write.name.trim() || write.name.length > 500) throw new AISyncWriteRefused('name');
  if (write.lifecycle !== undefined && write.lifecycle !== 'live' && write.lifecycle !== 'retired') throw new AISyncWriteRefused('lifecycle');
  storableAttributes(write.attributes);
  const key = NATURAL_KEYS[write.class].map(field => {
    const value = write.attributes[field];
    if (typeof value !== 'string' || !value || (field === 'release_digest' && !DIGEST.test(value))) {
      throw new AISyncWriteRefused(`natural key ${field}`);
    }
    return value;
  });
  // The lifecycle is written only when the source states it; an update without one keeps the stored value (HAP-1604 A1).
  return { key, properties: { ...write.attributes, authoritative_source: route.source,
    ...(write.lifecycle !== undefined ? { lifecycle: write.lifecycle } : {}) } };
}

/**
 * A stored Neo4j value equals the value a write would set (integers come back as neo4j Integer, lists as arrays, and
 * Neo4j stores no null, so a null is equal to an absent property).
 */
function sameValue(stored: unknown, next: AIAttributeValue | undefined): boolean {
  if (Array.isArray(next)) return Array.isArray(stored) && stored.length === next.length && next.every((v, i) => stored[i] === v);
  if (isInt(stored)) return typeof next === 'number' && stored.toNumber() === next;
  if (next === null) return stored === null || stored === undefined;
  return stored === next;
}

export class AISyncWriter {
  constructor(private readonly neo4j: Neo4jClient) {}

  /**
   * Create the CI of this natural key, or update it in place; one journaled write, one audit row. `unchanged` (no write,
   * no audit row) when every property it would set already holds that value, the stream's as-of attribute aside.
   */
  async upsert(organizationId: string, stream: AISyncStream, write: AICIWrite): Promise<{ ciId: string; action: 'created' | 'updated' | 'unchanged' }> {
    const { key, properties } = validatedProperties(stream, write);
    const createOnly = storableAttributes(write.createOnly ?? {});
    const ciId = `ai_${createHash('sha256').update(JSON.stringify([organizationId, write.class, ...key])).digest('hex').slice(0, 32)}`;
    const actor = `sync:${stream}`;
    const existing = await this.neo4j.getCIProperties(ciId, organizationId);
    if (existing && existing['type'] !== write.class) throw new AISyncWriteRefused(`CI ${ciId} is not a ${write.class}`);
    if (!existing) {
      const ci: CIInput = { _id: ciId, name: write.name, _type: write.class };
      try {
        await this.neo4j.createCI(ci, organizationId, actor, { grant: SOURCE_OWNED_WRITE,
          properties: { lifecycle: 'live', ...createOnly, ...properties } }, 'system');
        return { ciId, action: 'created' };
      } catch (error) {
        // ci_id_unique: a concurrent write of the same key created it first; this write becomes its update.
        if (!(error instanceof JournalAbortedError)) throw error;
      }
    }
    const asOf = STREAMS[stream].asOf;
    const next: Record<string, AIAttributeValue> = { name: write.name, ...properties };
    if (existing && Object.entries(next).every(([field, value]) => field === asOf || sameValue(existing[field], value))) {
      return { ciId, action: 'unchanged' };
    }
    const updated = await this.neo4j.updateCIProperties(ciId, next, organizationId, actor, SOURCE_OWNED_WRITE, 'system');
    if (!updated) throw new AISyncWriteRefused(`CI ${ciId} is missing`);
    return { ciId, action: 'updated' };
  }

  /**
   * Add the stream's `type` relationship between two of this organization's AI CIs once: `unchanged` (no write) when
   * it exists. One journaled relationship write by `sync:<stream>` (actor type `system`); there is no unlink.
   */
  async link(organizationId: string, stream: AISyncStream, fromCiId: string, type: string, toCiId: string): Promise<'created' | 'unchanged'> {
    const route = Object.hasOwn(STREAMS, stream) ? STREAMS[stream] : undefined;
    const allowed = route?.links.find(link => link.type === type);
    if (!allowed) throw new AISyncWriteRefused(`stream ${String(stream)} does not link ${String(type)}`);
    const [from, to] = await Promise.all([fromCiId, toCiId].map(id => this.neo4j.getCIProperties(id, organizationId)));
    if (from?.['type'] !== allowed.from || to?.['type'] !== allowed.to) throw new AISyncWriteRefused(`${type} needs ${allowed.from} -> ${allowed.to}`);
    if (await this.neo4j.relationshipExists(organizationId, fromCiId, type, toCiId)) return 'unchanged';
    const written = await this.neo4j.writeRelationship('relationship_create', fromCiId, toCiId, type, organizationId, `sync:${stream}`,
      {}, SOURCE_OWNED_WRITE, 'system');
    if (!written) throw new AISyncWriteRefused(`${type} endpoint is missing`);
    return 'created';
  }

  /** This organization's natural-key values of a single-key class (e.g. every held release_digest), in key order. */
  async heldKeys(organizationId: string, cls: SourceOwnedCIType): Promise<string[]> {
    const [field] = NATURAL_KEYS[cls];
    if (NATURAL_KEYS[cls].length !== 1 || !field) throw new AISyncWriteRefused(`${cls} has a composite key`);
    const keys: string[] = [];
    for (let page = await this.neo4j.listOwnedKeys(organizationId, cls, field, ''); page.length;
      page = await this.neo4j.listOwnedKeys(organizationId, cls, field, page.at(-1)!)) keys.push(...page);
    return keys;
  }
}
