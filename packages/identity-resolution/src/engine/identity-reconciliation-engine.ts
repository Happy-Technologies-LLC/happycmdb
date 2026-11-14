// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * IdentityReconciliationEngine (v2.0)
 * Multi-source CI deduplication and reconciliation
 */

import { createHash, randomUUID } from 'crypto';
import { ciIncarnationId, isSourceOwnedCIType, logger, sanitizeCITypeForLabel, SourceOwnedError } from '@cmdb/common';
import {
  enc, getNeo4jClient, getPostgresClient, JournalConflictError, PlanUnrepresentableError, type ConflictPlan,
  type JournalActorType, type StoredPlan,
} from '@cmdb/database';
import { IdentificationAttributes, TransformedCI } from '@cmdb/integration-framework';
import { FieldMergeRule, MatchResult, ReconciliationConfig } from '../types/reconciliation.types';
import * as fuzzball from 'fuzzball';
import { getEventProducer, EventType, type CIDiscoveredEvent, type CIUpdatedEvent } from '@cmdb/event-processor';
import { isMergeable } from './mergeable-attributes';

/**
 * HAP-1442: a discovered or merged CI may not create or claim an AI class; only AISyncWriter writes them. A merge into
 * an existing AI CI is refused by the client's owned-write admission (before T1), whatever the source's authority.
 * Checks every key the created node's property map is built from (ci_type, attributes, identifiers), in any spelling.
 */
function refuseSourceOwnedClass(ci: TransformedCI): void {
  const fields = [...Object.entries(ci.attributes ?? {}), ...Object.entries(ci.identifiers ?? {}), ['ci_type', ci.ci_type]];
  if (fields.some(([key, value]) => ['type', 'ci_type'].includes(String(key).replace(/^_+/, '').toLowerCase())
    && isSourceOwnedCIType(value))) {
    throw new SourceOwnedError();
  }
}

/** HAP-499: one metadata-only line per merge; attribute keys and values are caller data and never logged. */
function logIgnoredAttributes(ci: TransformedCI): void {
  const ignored = Object.keys(ci.attributes ?? {}).filter(key => !isMergeable(key)).length;
  if (ignored) logger.warn('Merge ignored non-mergeable attributes', { ignored_attribute_count: ignored });
}

/** v16 §7.0 canon(v): sorted keys (UTF-16 order), no whitespace, ECMAScript JSON escaping, quoted strings. */
export function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canon(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** v16 §7.0 H(F, old, new, source, source_id); a side is ["v", value] or, when absent, ["absent"]. */
export function conflictHash(field: string, old: { value: unknown } | null, next: { value: unknown } | null,
  source: string, sourceId: string): string {
  const side = (present: { value: unknown } | null) => present ? ['v', present.value] : ['absent'];
  return createHash('sha256').update(canon(['hp1-conflict-v1', field, side(old), side(next), source, sourceId])).digest('hex');
}

/** v16 §7.0 field_value text: strings verbatim, numbers/booleans unchanged, null "null", collections canon. */
function fieldText(value: unknown): string {
  return typeof value === 'string' ? value : value !== null && typeof value === 'object' ? canon(value) : String(value);
}

interface StoredField { value_json: unknown; source_name: string; last_correlation_id: string | null }
interface ConflictRow {
  id: string; field_name: string; status: string; content_hash: string; suppression_hash: string | null;
  source_name: string; source_id: string; incoming_json: unknown; target_json: unknown; target_source_name: string;
}
/** v16 §7.3: stale iff O's field source is absent, from another source, or holds another value than the target. */
function isStale(conflict: ConflictRow, stored: StoredField | undefined): boolean {
  return !stored || stored.source_name !== conflict.target_source_name || canon(stored.value_json) !== canon(conflict.target_json);
}

export interface MergeOutcome {
  ci_id: string; action: 'created' | 'updated' | 'pending_review'; correlation_id: string; conflict_ids: string[];
}
export type ConflictResolution = 'accept_source' | 'accept_target' | 'merge' | 'dismiss_stale';
/** v16 §4.4, HAP-499: the mergeable entries of an attribute or identifier map; everything else is never written. */
const mergeable = (map: object = {}): Record<string, unknown> => Object.fromEntries(Object.entries(map)
  .filter(([key, value]) => value !== undefined && isMergeable(key)));
/**
 * HAP-1732: the request's top-level fields; a new node always carries them as sent, so an attribute or identifier of the
 * same name is never written, recorded or audited on create. An update never writes the top-level fields: there such an
 * attribute is a policy-governed field like any other (source authority, review rules, field sources).
 */
const TOP_LEVEL_FIELDS = new Set(['name', 'ci_type', 'status', 'environment']);
const mergeableOnCreate = (map: object = {}): Record<string, unknown> => Object.fromEntries(Object.entries(mergeable(map))
  .filter(([key]) => !TOP_LEVEL_FIELDS.has(key)));

export class IdentityReconciliationEngine {
  private static instance: IdentityReconciliationEngine;
  private neo4jClient = getNeo4jClient();
  private postgresClient = getPostgresClient();
  private eventProducer = getEventProducer();

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): IdentityReconciliationEngine {
    if (!IdentityReconciliationEngine.instance) {
      IdentityReconciliationEngine.instance = new IdentityReconciliationEngine();
    }
    return IdentityReconciliationEngine.instance;
  }

  /**
   * v16 §8: the requesting organization's newest enabled rule and its authorities,
   * read per operation (no process cache). Org row → code default → 5; legacy
   * NULL-org rules and authorities are inert.
   */
  private async loadPolicy(organizationId: string): Promise<{ review: Set<string>; authority: (source: string) => number }> {
    const result = await this.postgresClient.query(`SELECT
        (SELECT merge_strategies FROM reconciliation_rules WHERE organization_id = $1 AND enabled
          ORDER BY updated_at DESC, id DESC LIMIT 1) AS merge_strategies,
        (SELECT coalesce(jsonb_object_agg(source_name, authority_score), '{}'::jsonb) FROM source_authority
          WHERE organization_id = $1) AS authorities`, [organizationId]);
    const row = result.rows[0] ?? {};
    const rules: FieldMergeRule[] = Array.isArray(row.merge_strategies) ? row.merge_strategies : [];
    const authorities: Record<string, number> = { ...this.getDefaultConfiguration().source_authorities, ...row.authorities };
    return {
      review: new Set(rules.filter(rule => rule?.strategy === 'manual_review').map(rule => rule.field_name)),
      authority: source => Object.prototype.hasOwnProperty.call(authorities, source) ? authorities[source]! : 5,
    };
  }

  /** O's field sources of a CI; never another organization's or legacy rows. */
  private async loadFieldSources(organizationId: string, ciId: string): Promise<Map<string, StoredField>> {
    const result = await this.postgresClient.query(`SELECT field_name, value_json, source_name, last_correlation_id
      FROM ci_field_sources WHERE organization_id = $1 AND ci_id = $2`, [organizationId, ciId]);
    return new Map(result.rows.map(row => [row.field_name as string, row as StoredField]));
  }

  /**
   * Find existing CI using cascading match strategies
   */
  async findExistingCI(
    identifiers: IdentificationAttributes,
    discoveredCI: TransformedCI,
    organizationId: string
  ): Promise<MatchResult | null> {
    // Strategy 1: Exact external_id match (100% confidence)
    if (identifiers.external_id) {
      const match = await this.findByExternalId(identifiers.external_id, discoveredCI.source, organizationId);
      if (match) {
        return {
          ci_id: match.ci_id,
          confidence: 100,
          match_strategy: 'external_id',
          matched_attributes: ['external_id'],
        };
      }
    }

    // Strategy 2: Serial number match (95% confidence)
    if (identifiers.serial_number) {
      const match = await this.findByAttribute('serial_number', identifiers.serial_number, organizationId);
      if (match) {
        return {
          ci_id: match,
          confidence: 95,
          match_strategy: 'serial_number',
          matched_attributes: ['serial_number'],
        };
      }
    }

    // Strategy 3: UUID match (95% confidence)
    if (identifiers.uuid) {
      const match = await this.findByAttribute('uuid', identifiers.uuid, organizationId);
      if (match) {
        return {
          ci_id: match,
          confidence: 95,
          match_strategy: 'uuid',
          matched_attributes: ['uuid'],
        };
      }
    }

    // Strategy 4: MAC address match (85% confidence)
    if (identifiers.mac_address && identifiers.mac_address.length > 0) {
      const match = await this.findByMacAddress(identifiers.mac_address, organizationId);
      if (match) {
        return {
          ci_id: match,
          confidence: 85,
          match_strategy: 'mac_address',
          matched_attributes: ['mac_address'],
        };
      }
    }

    // Strategy 5: FQDN match (80% confidence)
    if (identifiers.fqdn) {
      const match = await this.findByAttribute('fqdn', identifiers.fqdn, organizationId);
      if (match) {
        return {
          ci_id: match,
          confidence: 80,
          match_strategy: 'fqdn',
          matched_attributes: ['fqdn'],
        };
      }
    }

    // Strategy 6: Composite fuzzy match (65% confidence)
    if (identifiers.hostname && identifiers.ip_address) {
      const match = await this.findByComposite(identifiers, organizationId);
      if (match) {
        return {
          ci_id: match.ci_id,
          confidence: match.confidence,
          match_strategy: 'composite_fuzzy',
          matched_attributes: match.matched_attributes,
        };
      }
    }

    // No match found
    return null;
  }

  /**
   * Find CI by external_id from specific source
   */
  private async findByExternalId(externalId: string, source: string, organizationId: string): Promise<{ ci_id: string } | null> {
    // Only O's lineage: a former owner's (or legacy) lineage of a reused id never identifies O's CI.
    const result = await this.postgresClient.query(
      `SELECT ci_id FROM ci_source_lineage
       WHERE source_name = $1 AND source_id = $2 AND organization_id = $3
       ORDER BY last_seen_at DESC`,
      [source, externalId, organizationId]
    );
    if (result.rows.length === 0) return null;

    const session = this.neo4jClient.getSession();
    try {
      const owned = await session.run(
        `UNWIND range(0, size($ciIds) - 1) AS rank
         WITH rank, $ciIds[rank] AS ciId
         MATCH (ci:CI {id: ciId})
         WHERE ci.organization_id = $organizationId
         RETURN ci.id as ci_id
         ORDER BY rank LIMIT 1`,
        { ciIds: result.rows.map(row => row.ci_id), organizationId }
      );
      return owned.records[0] ? { ci_id: owned.records[0].get('ci_id') } : null;
    } finally {
      await session.close();
    }
  }

  /**
   * Find CI by single attribute in Neo4j
   */
  private async findByAttribute(attributeName: string, value: any, organizationId: string): Promise<string | null> {
    const session = this.neo4jClient.getSession();

    try {
      const result = await session.run(
        `MATCH (ci:CI)
         WHERE ci.organization_id = $organizationId AND ci.${attributeName} = $value
         RETURN ci.id as ci_id
         LIMIT 1`,
        { value, organizationId }
      );

      const firstRecord = result.records[0];
      if (firstRecord) {
        return firstRecord.get('ci_id');
      }

      return null;
    } finally {
      await session.close();
    }
  }

  /**
   * Find CI by MAC address array
   */
  private async findByMacAddress(macAddresses: string[], organizationId: string): Promise<string | null> {
    const session = this.neo4jClient.getSession();

    try {
      const result = await session.run(
        `MATCH (ci:CI)
         WHERE ci.organization_id = $organizationId
           AND ANY(mac IN ci.mac_addresses WHERE mac IN $macs)
         RETURN ci.id as ci_id
         LIMIT 1`,
        { macs: macAddresses, organizationId }
      );

      const firstRecord = result.records[0];
      if (firstRecord) {
        return firstRecord.get('ci_id');
      }

      return null;
    } finally {
      await session.close();
    }
  }

  /**
   * Find CI by composite fuzzy matching
   */
  private async findByComposite(identifiers: IdentificationAttributes, organizationId: string): Promise<MatchResult | null> {
    const session = this.neo4jClient.getSession();

    try {
      // Find candidates by IP address or hostname
      const result = await session.run(
        `MATCH (ci:CI)
         WHERE ci.organization_id = $organizationId
           AND (ci.hostname CONTAINS $hostname
             OR ANY(ip IN ci.ip_addresses WHERE ip IN $ips))
         RETURN ci.id as ci_id, ci.hostname as hostname, ci.ip_addresses as ips
         LIMIT 10`,
        {
          organizationId,
          hostname: identifiers.hostname?.toLowerCase() || '',
          ips: identifiers.ip_address || []
        }
      );

      let bestMatch: MatchResult | null = null;
      let bestScore = 0;

      for (const record of result.records) {
        const candidateHostname = record.get('hostname');
        const candidateIps = record.get('ips') || [];

        let score = 0;
        const matchedAttrs: string[] = [];

        // Fuzzy hostname match
        if (identifiers.hostname && candidateHostname) {
          const similarity = fuzzball.ratio(
            identifiers.hostname.toLowerCase(),
            candidateHostname.toLowerCase()
          );

          if (similarity > 80) {
            score += similarity;
            matchedAttrs.push('hostname');
          }
        }

        // IP address overlap
        if (identifiers.ip_address && candidateIps.length > 0) {
          const overlap = identifiers.ip_address.filter(ip => candidateIps.includes(ip));
          if (overlap.length > 0) {
            score += 50;
            matchedAttrs.push('ip_address');
          }
        }

        if (score > bestScore && score > 65) {
          bestScore = score;
          bestMatch = {
            ci_id: record.get('ci_id'),
            confidence: Math.min(score, 95),
            match_strategy: 'composite_fuzzy',
            matched_attributes: matchedAttrs,
          };
        }
      }

      return bestMatch;
    } finally {
      await session.close();
    }
  }

  /**
   * Create or update CI with reconciliation. The engine acts on its own behalf: actor `system:identity-reconciliation`,
   * audit actor type `system` (HAP-1608).
   */
  async reconcileCI(discoveredCI: TransformedCI, organizationId: string, createIfMissing = true): Promise<string | null> {
    const identifiers = discoveredCI.identifiers;
    refuseSourceOwnedClass(discoveredCI);
    logIgnoredAttributes(discoveredCI);

    // Find existing CI
    const match = await this.findExistingCI(identifiers, discoveredCI, organizationId);

    if (match) {
      logger.info('Existing CI found, updating', {
        ci_id: match.ci_id,
        confidence: match.confidence,
        strategy: match.match_strategy
      });

      return (await this.mergeIntoCI(match, discoveredCI, organizationId, 'system:identity-reconciliation', 'system'))
        ? match.ci_id : null;
    } else if (!createIfMissing) {
      return null;
    } else {
      logger.info('No existing CI found, creating new', {
        name: discoveredCI.name,
        source: discoveredCI.source
      });

      // One journaled create (history, audit, lineage, field sources) under the stable id of (O, source, source_id);
      // it emits CI_DISCOVERED after T2. A missing or over-255 source_id/source is a PlanUnrepresentableError.
      return (await this.createFromMerge(discoveredCI, organizationId, 'system:identity-reconciliation', 'system')).ci_id;
    }
  }

  /**
   * REST/GraphQL merge into an existing owned CI (v16 §3.1, §7): updated or held for review. Unmatched: null,
   * or for REST (`createIfMissing`) one journaled create, so foreign, NULL-org and missing targets look alike.
   */
  async mergeCI(discoveredCI: TransformedCI, organizationId: string, actor: string,
    createIfMissing = false): Promise<MergeOutcome | null> {
    refuseSourceOwnedClass(discoveredCI);
    logIgnoredAttributes(discoveredCI);
    await this.neo4jClient.assertJournalReady(true); // v16 §3.2: the gate precedes identification (lineage/graph reads)
    const match = await this.findExistingCI(discoveredCI.identifiers, discoveredCI, organizationId);
    if (match) return this.mergeIntoCI(match, discoveredCI, organizationId, actor, 'user');
    return createIfMissing ? this.createFromMerge(discoveredCI, organizationId, actor) : null;
  }

  /**
   * v16 §3.1/§3.3, §15 H-1: one journaled `create` under the id of (O, source, source_id). W stamps the verified
   * org; T2 writes exactly one `created` history row, the lineage and the attribute field sources.
   * Only mergeable attributes and identifiers reach the node (HAP-499), so `external_id` never does through any merge
   * path (create, update, hold or resolve): a database not yet migrated by Neo4j 005 keeps a global constraint on it,
   * so a collision would disclose another org's value. That identity is O's lineage (findByExternalId).
   */
  private async createFromMerge(ci: TransformedCI, organizationId: string, actor: string,
    actorType: JournalActorType = 'user'): Promise<MergeOutcome> {
    const { source, source_id: sourceId } = ci;
    if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 255 || source.length > 255) throw new PlanUnrepresentableError();
    const attributes = mergeableOnCreate(ci.attributes);
    const fields = { name: ci.name, ci_type: ci.ci_type, status: ci.status || 'active',
      ...(ci.environment ? { environment: ci.environment } : {}), ...attributes, ...mergeableOnCreate(ci.identifiers) };
    // One stable slot per (O, source, source_id): a retry while T2 is pending meets the in-flight gap (409), never a 2nd CI.
    const ciId = `ci_${createHash('sha256').update(JSON.stringify([organizationId, source, sourceId])).digest('hex').slice(0, 32)}`;
    const incarnationId = randomUUID();
    const outcome = await this.neo4jClient.journal.run({
      organizationId, actor, actorType, operation: 'create', ciIds: [ciId],
      plan: async () => ({
        graph: { kind: 'create', label: sanitizeCITypeForLabel(ci.ci_type),
          params: enc({ id: ciId, props: { ...fields, incarnation_id: incarnationId } }) },
        history: { changeType: 'created', changedFields: Object.keys(fields), source, previous: enc({}), next: enc(fields),
          incarnationId: ciIncarnationId(incarnationId) },
        fields: Object.entries(attributes).map(([name, value]) => ({ name, value, text: fieldText(value), source })),
        lineage: { source, sourceId, confidence: ci.confidence_score ?? null },
        // HAP-1001: explicit changes (D13), so a stored plan recovered by an older image stays truthful.
        audit: { action: 'CREATE', changes: enc(Object.entries(fields).map(([field, value]) => ({ field, old_value: null,
          new_value: value }))) },
      }),
      result: async groupId => ({ ci_id: ciId, action: 'created' as const, correlation_id: groupId, conflict_ids: [] }),
    });
    try { // v16 §3.3 step 7: after T2, best-effort
      await this.eventProducer.emit<CIDiscoveredEvent>(EventType.CI_DISCOVERED, 'identity-reconciliation-engine', {
        ci_id: ciId, organization_id: organizationId, ci_incarnation_id: incarnationId, ci_name: ci.name, ci_type: ci.ci_type,
        source_system: source, confidence_score: ci.confidence_score, identifiers: ci.identifiers });
    } catch {
      logger.warn('CI discovered notification not published', { ci_id: ciId });
    }
    return outcome;
  }

  /**
   * v16 §3.3, §7.1–7.2: one journaled `update` whose plan, under the slot, reads O's policy,
   * field sources and this source's conflicts and classifies every field suppressed | review |
   * merge. Any review field holds the whole merge: no W, fence, field/lineage/history row or
   * event; T2 writes only the conflicts, and identical content reuses the pending conflict id.
   * Changed content against a live (non-stale) pending conflict aborts as pending_content.
   */
  private async mergeIntoCI(match: MatchResult, ci: TransformedCI, organizationId: string,
    actor: string, actorType: JournalActorType): Promise<MergeOutcome | null> {
    const { source, source_id: sourceId } = ci;
    // T2 writes both into VARCHAR(255) evidence; refusing after W would leave a permanently failed gap.
    if (typeof sourceId !== 'string' || !sourceId || sourceId.length > 255 || source.length > 255) {
      throw new PlanUnrepresentableError();
    }
    const conflictIds: string[] = [];
    let applied: Record<string, unknown> | null = null;
    let incarnationId: string | null = null;
    const outcome = await this.neo4jClient.reconcileOwned(match.ci_id, organizationId, actor, 'update', async current => {
      const stored = await this.loadFieldSources(organizationId, match.ci_id);
      const policy = await this.loadPolicy(organizationId);
      const known: ConflictRow[] = (await this.postgresClient.query(`SELECT id, field_name, status, content_hash,
          suppression_hash, source_name, source_id, incoming_json, target_json, target_source_name
        FROM reconciliation_conflicts WHERE organization_id = $1 AND ci_id = $2 AND source_name = $3 AND source_id = $4
          AND status IN ('pending', 'resolved')`, [organizationId, match.ci_id, source, sourceId])).rows;
      const merged: Record<string, unknown> = {};
      const conflicts: ConflictPlan[] = [];
      for (const [field, value] of Object.entries(mergeable(ci.attributes))) {
        const target = stored.get(field);
        const hash = conflictHash(field, target ? { value: target.value_json } : null, { value }, source, sourceId);
        if (known.some(row => row.status === 'resolved' && row.field_name === field && row.suppression_hash === hash)) continue;
        if (policy.review.has(field) && target && target.source_name !== source && canon(target.value_json) !== canon(value)) {
          const pending = known.find(row => row.status === 'pending' && row.field_name === field);
          if (pending?.content_hash === hash) {
            conflictIds.push(pending.id);
            continue;
          }
          if (pending && !isStale(pending, target)) throw new JournalConflictError('pending_content');
          const id = randomUUID();
          conflictIds.push(id);
          conflicts.push({ id, field, source, sourceId, incoming: value, target: target.value_json,
            targetSource: target.source_name, contentHash: hash, targetCorrelationId: target.last_correlation_id,
            ...(pending ? { supersedes: { id: pending.id, contentHash: pending.content_hash } } : {}) });
        } else if (!target || policy.authority(source) >= policy.authority(target.source_name)) {
          merged[field] = value;
        }
      }
      if (conflictIds.length) return { graph: null, operation: 'hold', conflicts };
      applied = merged;
      const keys = Object.keys(merged);
      // A pre-incarnation node gets its marker in the same W, so the history row names it.
      const existing = current['incarnation_id'];
      incarnationId = typeof existing === 'string' ? existing : randomUUID();
      return {
        graph: { kind: 'update', label: null,
          params: enc({ id: match.ci_id, props: typeof existing === 'string' ? merged : { ...merged, incarnation_id: incarnationId } }) },
        history: { changeType: 'updated', changedFields: keys, source, next: enc(merged), incarnationId: ciIncarnationId(incarnationId),
          previous: enc(Object.fromEntries(keys.map(key => [key, current[key] ?? null]))) },
        fields: keys.map(name => ({ name, value: merged[name], text: fieldText(merged[name]), source })),
        lineage: { source, sourceId, confidence: match.confidence },
        audit: { action: 'UPDATE', changes: enc(keys.map(field => ({ field, old_value: current[field] ?? null,
          new_value: merged[field] }))) },
      };
    }, async groupId => ({ ci_id: match.ci_id, action: applied ? 'updated' as const : 'pending_review' as const,
      correlation_id: groupId, conflict_ids: conflictIds }), undefined, actorType);
    const changed: Record<string, unknown> = applied ?? {};
    if (outcome?.action === 'updated' && Object.keys(changed).length) {
      // v16 §3.3 step 7: notify after T2, best-effort; a Kafka failure cannot undo or fail the committed write.
      try {
        await this.eventProducer.emit<CIUpdatedEvent>(EventType.CI_UPDATED, 'identity-reconciliation-engine', {
          ci_id: match.ci_id, organization_id: organizationId, ci_incarnation_id: incarnationId!, ci_name: ci.name,
          changed_fields: Object.keys(changed), previous_values: {}, new_values: changed, source_system: source,
        });
      } catch {
        logger.warn('CI updated notification not published', { ci_id: match.ci_id });
      }
    }
    return outcome;
  }

  /**
   * v16 §7.4: load the conflict by id and O (else the identical 404), then one journaled
   * `resolve_conflict` on the owned CI. Under the slot the row must still be pending at
   * `expectedRevision` (else 409); a stale row accepts only dismiss_stale, a fresh row never.
   * accept_source/merge write F (W) and its field source; accept_target/dismiss_stale have no graph effect.
   */
  async resolveConflict(organizationId: string, actor: string, conflictId: string, resolution: ConflictResolution,
    expectedRevision: string, mergedValue?: unknown): Promise<{ ci_id: string; status: string; correlation_id: string } | null> {
    await this.neo4jClient.assertJournalReady(true); // v16 §3.2: the gate precedes the owner lookup
    const owner = (await this.postgresClient.query(`SELECT ci_id, field_name, incoming_json FROM reconciliation_conflicts
      WHERE id = $1 AND organization_id = $2`, [conflictId, organizationId])).rows[0];
    if (!owner) return null;
    // HAP-1442: no resolution may give a CI an AI class. The plan's revision check pins incoming_json to this read.
    const written = resolution === 'accept_source' ? owner.incoming_json : resolution === 'merge' ? mergedValue : undefined;
    if (['type', 'ci_type'].includes(String(owner.field_name).replace(/^_+/, '').toLowerCase()) && isSourceOwnedCIType(written)) {
      throw new SourceOwnedError();
    }
    // HAP-1099/HAP-499: a write to a non-mergeable field (external_id, type, ...) is one fixed 422 before admission.
    if ((resolution === 'accept_source' || resolution === 'merge') && !isMergeable(owner.field_name)) throw new PlanUnrepresentableError();
    const ciId: string = owner.ci_id;
    const status = resolution === 'dismiss_stale' ? 'superseded' as const : 'resolved' as const;
    return this.neo4jClient.reconcileOwned(ciId, organizationId, actor, 'resolve_conflict', async (current): Promise<StoredPlan> => {
      const conflict: ConflictRow | undefined = (await this.postgresClient.query(`SELECT id, field_name, status, content_hash,
          suppression_hash, source_name, source_id, incoming_json, target_json, target_source_name
        FROM reconciliation_conflicts WHERE id = $1 AND organization_id = $2 AND ci_id = $3`,
      [conflictId, organizationId, ciId])).rows[0];
      if (!conflict || conflict.status !== 'pending' || conflict.content_hash !== expectedRevision) {
        throw new JournalConflictError('revision_mismatch');
      }
      const field = conflict.field_name;
      const stale = isStale(conflict, (await this.loadFieldSources(organizationId, ciId)).get(field));
      if (stale !== (resolution === 'dismiss_stale')) throw new JournalConflictError(stale ? 'stale_conflict' : 'not_stale');
      const resolve = { id: conflictId, revision: expectedRevision, status, action: resolution,
        data: enc(resolution === 'merge' ? { resolution, value: mergedValue } : { resolution }) };
      if (resolution === 'dismiss_stale') {
        return { graph: null, resolve: { ...resolve, suppressionHash: null }, history: {
          changeType: 'conflict_superseded', changedFields: [field], source: conflict.source_name,
          previous: enc({ [field]: conflict.target_json }), next: enc({ [field]: conflict.incoming_json }),
          incarnationId: ciIncarnationId(current['incarnation_id'] as string | null) } };
      }
      if (resolution === 'accept_target') return { graph: null, resolve: { ...resolve, suppressionHash: conflict.content_hash } };
      const value = resolution === 'accept_source' ? conflict.incoming_json : mergedValue;
      return {
        graph: { kind: 'update', label: null, params: enc({ id: ciId, props: { [field]: value } }) },
        fields: [{ name: field, value, text: fieldText(value),
          source: resolution === 'accept_source' ? conflict.source_name : 'manual_resolution' }],
        resolve: { ...resolve, suppressionHash: conflictHash(field, { value }, { value: conflict.incoming_json },
          conflict.source_name, conflict.source_id) },
        audit: { action: 'UPDATE', changes: enc([{ field, old_value: current[field] ?? null, new_value: value }]) },
      };
    }, async groupId => ({ ci_id: ciId, status, correlation_id: groupId }));
  }

  /**
   * Get default configuration
   */
  private getDefaultConfiguration(): ReconciliationConfig {
    return {
      name: 'default',
      identification_rules: [
        { attribute: 'external_id', priority: 1, match_type: 'exact', match_confidence: 100 },
        { attribute: 'serial_number', priority: 2, match_type: 'exact', match_confidence: 95 },
        { attribute: 'uuid', priority: 3, match_type: 'exact', match_confidence: 95 },
        { attribute: 'mac_address', priority: 4, match_type: 'exact', match_confidence: 85 },
        { attribute: 'fqdn', priority: 5, match_type: 'exact', match_confidence: 80 },
      ],
      merge_rules: [],
      source_authorities: {
        servicenow: 10,
        vmware: 9,
        aws: 9,
        azure: 9,
        gcp: 9,
        ssh: 7,
        nmap: 5,
      }
    };
  }
}

/**
 * Get singleton instance
 */
export function getIdentityReconciliationEngine(): IdentityReconciliationEngine {
  return IdentityReconciliationEngine.getInstance();
}
