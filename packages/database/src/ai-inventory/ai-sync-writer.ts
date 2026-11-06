// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * HAP-1442 (AAI S1): the only writer of the source-owned AI CI classes (design brief §4, A1). Each upsert is one
 * journaled Neo4jClient write (createCI or updateCIProperties) holding SOURCE_OWNED_WRITE, by actor `sync:<stream>`,
 * so it appends exactly one hash-chained audit_log row. The CI id is derived from the organization, class and natural
 * key, so a second write of the same key updates the CI instead of creating another.
 */
import { createHash } from 'crypto';
import type { AILifecycle, AuthoritativeSource, CIInput, SourceOwnedCIType } from '@cmdb/common';
import { JournalAbortedError } from '../journal/journal';
import type { Neo4jClient } from '../neo4j/client';
import { SOURCE_OWNED_WRITE } from '../neo4j/source-owned-grant';

export type AISyncStream = 'c4_releases' | 'c8_cells' | 'c8_admissions';
export type AIAttributeValue = string | number | boolean | null;

export interface AICIWrite {
  class: SourceOwnedCIType;
  name: string;
  lifecycle?: AILifecycle;
  /** Source fields stored as top-level CI properties; the class's natural key fields are required. */
  attributes: Record<string, AIAttributeValue>;
}

/** Which classes a stream writes and the source of record it speaks for. */
const STREAMS: Record<AISyncStream, { source: AuthoritativeSource; classes: readonly SourceOwnedCIType[] }> = {
  c4_releases: { source: 'happylab-c4', classes: ['agent-release', 'ai-model'] },
  c8_cells: { source: 'hivecell-c8', classes: ['cell'] },
  c8_admissions: { source: 'hivecell-c8', classes: ['ai-deployment'] },
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

function validatedProperties(stream: AISyncStream, write: AICIWrite): { key: string[]; properties: Record<string, AIAttributeValue> } {
  const route = Object.hasOwn(STREAMS, stream) ? STREAMS[stream] : undefined;
  if (!route?.classes.includes(write.class)) throw new AISyncWriteRefused(`stream ${String(stream)} does not write ${String(write.class)}`);
  if (typeof write.name !== 'string' || !write.name.trim() || write.name.length > 500) throw new AISyncWriteRefused('name');
  if (write.lifecycle !== undefined && write.lifecycle !== 'live' && write.lifecycle !== 'retired') throw new AISyncWriteRefused('lifecycle');
  for (const [field, value] of Object.entries(write.attributes)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(field) || RESERVED.includes(field)) throw new AISyncWriteRefused(`attribute ${field}`);
    const storable = value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
      || (typeof value === 'string' && value.length <= 4096);
    if (!storable) throw new AISyncWriteRefused(`attribute ${field} value`);
  }
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

export class AISyncWriter {
  constructor(private readonly neo4j: Neo4jClient) {}

  /** Create the CI of this natural key, or update it in place; one journaled write, one audit row. */
  async upsert(organizationId: string, stream: AISyncStream, write: AICIWrite): Promise<{ ciId: string; action: 'created' | 'updated' }> {
    const { key, properties } = validatedProperties(stream, write);
    const ciId = `ai_${createHash('sha256').update(JSON.stringify([organizationId, write.class, ...key])).digest('hex').slice(0, 32)}`;
    const actor = `sync:${stream}`;
    const existing = await this.neo4j.getCI(ciId, organizationId);
    if (existing && existing._type !== write.class) throw new AISyncWriteRefused(`CI ${ciId} is not a ${write.class}`);
    if (!existing) {
      const ci: CIInput = { _id: ciId, name: write.name, _type: write.class };
      try {
        await this.neo4j.createCI(ci, organizationId, actor, { grant: SOURCE_OWNED_WRITE,
          properties: { lifecycle: 'live', ...properties } });
        return { ciId, action: 'created' };
      } catch (error) {
        // ci_id_unique: a concurrent write of the same key created it first; this write becomes its update.
        if (!(error instanceof JournalAbortedError)) throw error;
      }
    }
    const updated = await this.neo4j.updateCIProperties(ciId, { name: write.name, ...properties }, organizationId, actor,
      SOURCE_OWNED_WRITE);
    if (!updated) throw new AISyncWriteRefused(`CI ${ciId} is missing`);
    return { ciId, action: 'updated' };
  }
}
