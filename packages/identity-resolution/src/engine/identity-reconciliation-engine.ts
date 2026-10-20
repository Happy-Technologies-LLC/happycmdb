// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * IdentityReconciliationEngine (v2.0)
 * Multi-source CI deduplication and reconciliation
 */

import { createHash, randomUUID } from 'crypto';
import { ciIncarnationId, logger, sanitizeCITypeForLabel } from '@cmdb/common';
import {
  enc, getNeo4jClient, getPostgresClient, JournalConflictError, PlanUnrepresentableError, type ConflictPlan, type StoredPlan,
} from '@cmdb/database';
import { IdentificationAttributes, TransformedCI } from '@cmdb/integration-framework';
import { FieldMergeRule, MatchResult, ReconciliationConfig } from '../types/reconciliation.types';
import * as fuzzball from 'fuzzball';
import { getEventProducer, EventType, type CIDiscoveredEvent, type CIUpdatedEvent } from '@cmdb/event-processor';

/**
 * A CI's organization_id is written only from the caller's token organization
 * (or the backfill), never from reconciled data. Drops that key from a property
 * map that would otherwise be SET onto a :CI node.
 */
function withoutOrganizationId<T extends Record<string, unknown>>(properties: T): Omit<T, 'organization_id'> {
  const { organization_id: _ignored, ...rest } = properties;
  return rest;
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
  ci_id: string; action: 'updated' | 'pending_review'; correlation_id: string; conflict_ids: string[];
}
export type ConflictResolution = 'accept_source' | 'accept_target' | 'merge' | 'dismiss_stale';
const RESERVED_ATTRIBUTES = ['id', 'organization_id', 'organizationid', 'op_id', 'reconciliation_op_id', 'created_at',
  'incarnation_id'];

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
   * Create or update CI with reconciliation
   */
  async reconcileCI(discoveredCI: TransformedCI, organizationId: string, createIfMissing = true,
    actor = 'system:identity-reconciliation'): Promise<string | null> {
    const identifiers = discoveredCI.identifiers;

    // Find existing CI
    const match = await this.findExistingCI(identifiers, discoveredCI, organizationId);

    if (match) {
      logger.info('Existing CI found, updating', {
        ci_id: match.ci_id,
        confidence: match.confidence,
        strategy: match.match_strategy
      });

      return (await this.mergeIntoCI(match, discoveredCI, organizationId, actor)) ? match.ci_id : null;
    } else if (!createIfMissing) {
      return null;
    } else {
      logger.info('No existing CI found, creating new', {
        name: discoveredCI.name,
        source: discoveredCI.source
      });

      const { ciId, incarnationId } = await this.createNewCI(discoveredCI, organizationId);

      // Emit CI discovered event
      await this.eventProducer.emit<CIDiscoveredEvent>(
        EventType.CI_DISCOVERED,
        'identity-reconciliation-engine',
        {
          ci_id: ciId,
          organization_id: organizationId,
          ci_incarnation_id: incarnationId,
          ci_name: discoveredCI.name,
          ci_type: discoveredCI.ci_type,
          source_system: discoveredCI.source,
          confidence_score: discoveredCI.confidence_score,
          identifiers: discoveredCI.identifiers,
        }
      );

      return ciId;
    }
  }

  /**
   * Create new CI in Neo4j
   */
  private async createNewCI(ci: TransformedCI, organizationId: string): Promise<{ ciId: string; incarnationId: string }> {
    const session = this.neo4jClient.getSession();

    try {
      const ciId = this.generateCIId();

      const result = await session.run(
        `CREATE (ci:CI:${sanitizeCITypeForLabel(ci.ci_type)})
         SET ci = $properties, ci.incarnation_id = randomUUID()
         RETURN ci.id as ci_id, ci.incarnation_id AS incarnation_id`,
        {
          properties: {
            ...withoutOrganizationId({
              name: ci.name,
              ci_type: ci.ci_type,
              environment: ci.environment,
              status: ci.status || 'active',
              ...ci.attributes,
              ...ci.identifiers,
              id: ciId,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }),
            organization_id: organizationId,
          },
        }
      );

      // Record source lineage
      await this.recordSourceLineage(ciId, ci.source, ci.source_id, ci.confidence_score, organizationId);

      logger.info('New CI created', { ci_id: ciId, name: ci.name });
      return { ciId: result.records[0]!.get('ci_id') as string,
        incarnationId: result.records[0]!.get('incarnation_id') as string };
    } finally {
      await session.close();
    }
  }

  /** REST/GraphQL merge into an existing owned CI (v16 §3.1, §7): updated or held for review; null when unmatched. */
  async mergeCI(discoveredCI: TransformedCI, organizationId: string, actor: string): Promise<MergeOutcome | null> {
    const match = await this.findExistingCI(discoveredCI.identifiers, discoveredCI, organizationId);
    return match ? this.mergeIntoCI(match, discoveredCI, organizationId, actor) : null;
  }

  /**
   * v16 §3.3, §7.1–7.2: one journaled `update` whose plan, under the slot, reads O's policy,
   * field sources and this source's conflicts and classifies every field suppressed | review |
   * merge. Any review field holds the whole merge: no W, fence, field/lineage/history row or
   * event; T2 writes only the conflicts, and identical content reuses the pending conflict id.
   * Changed content against a live (non-stale) pending conflict aborts as pending_content.
   */
  private async mergeIntoCI(match: MatchResult, ci: TransformedCI, organizationId: string,
    actor: string): Promise<MergeOutcome | null> {
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
      for (const [field, value] of Object.entries(withoutOrganizationId(ci.attributes))) {
        // v16 §4.4: reserved aliases, timestamps and the incarnation are dropped, never written.
        if (RESERVED_ATTRIBUTES.includes(field.replace(/^_+/, '').toLowerCase())) continue;
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
          conflicts.push({ id, field, source, sourceId, incoming: enc(value), target: enc(target.value_json),
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
        fields: keys.map(name => ({ name, value: enc(merged[name]), text: fieldText(merged[name]), source })),
        lineage: { source, sourceId, confidence: match.confidence },
      };
    }, async groupId => ({ ci_id: match.ci_id, action: applied ? 'updated' as const : 'pending_review' as const,
      correlation_id: groupId, conflict_ids: conflictIds }));
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
    const owner = (await this.postgresClient.query(`SELECT ci_id FROM reconciliation_conflicts
      WHERE id = $1 AND organization_id = $2`, [conflictId, organizationId])).rows[0];
    if (!owner) return null;
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
        fields: [{ name: field, value: enc(value), text: fieldText(value),
          source: resolution === 'accept_source' ? conflict.source_name : 'manual_resolution' }],
        resolve: { ...resolve, suppressionHash: conflictHash(field, { value }, { value: conflict.incoming_json },
          conflict.source_name, conflict.source_id) },
      };
    }, async groupId => ({ ci_id: ciId, status, correlation_id: groupId }));
  }

  /** Lineage of a CI created by discovery/ETL (S5 residual: not yet journaled), keyed by organization. */
  private async recordSourceLineage(ciId: string, sourceName: string, sourceId: string, confidence: number,
    organizationId: string): Promise<void> {
    await this.postgresClient.query(
      `INSERT INTO ci_source_lineage (organization_id, ci_id, source_name, source_id, confidence_score, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (organization_id, ci_id, source_name, source_id)
       DO UPDATE SET last_seen_at = NOW(), confidence_score = $5`,
      [organizationId, ciId, sourceName, sourceId, Math.round(confidence)]
    );
  }

  /**
   * Generate unique CI ID
   */
  private generateCIId(): string {
    return `ci_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
