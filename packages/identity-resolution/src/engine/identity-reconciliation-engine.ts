// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * IdentityReconciliationEngine (v2.0)
 * Multi-source CI deduplication and reconciliation
 */

import { logger, sanitizeCITypeForLabel } from '@cmdb/common';
import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { IdentificationAttributes, TransformedCI } from '@cmdb/integration-framework';
import { MatchResult, ReconciliationConfig } from '../types/reconciliation.types';
import * as fuzzball from 'fuzzball';
import { getEventProducer } from '@cmdb/event-processor';
import { EventType } from '@cmdb/event-processor';

export class IdentityReconciliationEngine {
  private static instance: IdentityReconciliationEngine;
  private neo4jClient = getNeo4jClient();
  private postgresClient = getPostgresClient();
  private eventProducer = getEventProducer();
  private config: ReconciliationConfig | null = null;

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
   * Load reconciliation configuration
   */
  async loadConfiguration(): Promise<void> {
    // Load from database
    const result = await this.postgresClient.query(
      'SELECT * FROM reconciliation_rules WHERE enabled = true LIMIT 1'
    );

    if (result.rows.length === 0) {
      logger.warn('No reconciliation rules found, using default configuration');
      this.config = this.getDefaultConfiguration();
    } else {
      const row = result.rows[0];
      this.config = {
        name: row.name,
        identification_rules: row.identification_rules,
        merge_rules: row.merge_strategies,
        source_authorities: await this.loadSourceAuthorities(),
      };
    }

    logger.info('Reconciliation configuration loaded', {
      name: this.config.name,
      rules: this.config.identification_rules.length
    });
  }

  /**
   * Load source authority scores
   */
  private async loadSourceAuthorities(): Promise<Record<string, number>> {
    const result = await this.postgresClient.query(
      'SELECT source_name, authority_score FROM source_authority'
    );

    const authorities: Record<string, number> = {};
    for (const row of result.rows) {
      authorities[row.source_name] = row.authority_score;
    }

    return authorities;
  }

  /**
   * Find existing CI using cascading match strategies
   */
  async findExistingCI(
    identifiers: IdentificationAttributes,
    discoveredCI: TransformedCI
  ): Promise<MatchResult | null> {
    // Strategy 1: Exact external_id match (100% confidence)
    if (identifiers.external_id) {
      const match = await this.findByExternalId(identifiers.external_id, discoveredCI.source);
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
      const match = await this.findByAttribute('serial_number', identifiers.serial_number);
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
      const match = await this.findByAttribute('uuid', identifiers.uuid);
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
      const match = await this.findByMacAddress(identifiers.mac_address);
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
      const match = await this.findByAttribute('fqdn', identifiers.fqdn);
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
      const match = await this.findByComposite(identifiers);
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
  private async findByExternalId(externalId: string, source: string): Promise<{ ci_id: string } | null> {
    const result = await this.postgresClient.query(
      `SELECT ci_id FROM ci_source_lineage
       WHERE source_name = $1 AND source_id = $2
       ORDER BY last_seen_at DESC LIMIT 1`,
      [source, externalId]
    );

    return result.rows.length > 0 ? { ci_id: result.rows[0].ci_id } : null;
  }

  /**
   * Find CI by single attribute in Neo4j
   */
  private async findByAttribute(attributeName: string, value: any): Promise<string | null> {
    const session = this.neo4jClient.getSession();

    try {
      const result = await session.run(
        `MATCH (ci:CI)
         WHERE ci.${attributeName} = $value
         RETURN ci.id as ci_id
         LIMIT 1`,
        { value }
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
  private async findByMacAddress(macAddresses: string[]): Promise<string | null> {
    const session = this.neo4jClient.getSession();

    try {
      const result = await session.run(
        `MATCH (ci:CI)
         WHERE ANY(mac IN ci.mac_addresses WHERE mac IN $macs)
         RETURN ci.id as ci_id
         LIMIT 1`,
        { macs: macAddresses }
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
  private async findByComposite(identifiers: IdentificationAttributes): Promise<MatchResult | null> {
    const session = this.neo4jClient.getSession();

    try {
      // Find candidates by IP address or hostname
      const result = await session.run(
        `MATCH (ci:CI)
         WHERE ci.hostname CONTAINS $hostname
            OR ANY(ip IN ci.ip_addresses WHERE ip IN $ips)
         RETURN ci.id as ci_id, ci.hostname as hostname, ci.ip_addresses as ips
         LIMIT 10`,
        {
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
  async reconcileCI(discoveredCI: TransformedCI): Promise<string> {
    const identifiers = discoveredCI.identifiers;

    // Find existing CI
    const match = await this.findExistingCI(identifiers, discoveredCI);

    if (match) {
      logger.info('Existing CI found, updating', {
        ci_id: match.ci_id,
        confidence: match.confidence,
        strategy: match.match_strategy
      });

      await this.updateExistingCI(match.ci_id, discoveredCI, match);

      // Emit CI updated event
      await this.eventProducer.emit(
        EventType.CI_UPDATED,
        'identity-reconciliation-engine',
        {
          ci_id: match.ci_id,
          ci_name: discoveredCI.name,
          changed_fields: Object.keys(discoveredCI.attributes),
          previous_values: {},
          new_values: discoveredCI.attributes,
          source_system: discoveredCI.source,
        } as any
      );

      return match.ci_id;
    } else {
      logger.info('No existing CI found, creating new', {
        name: discoveredCI.name,
        source: discoveredCI.source
      });

      const ciId = await this.createNewCI(discoveredCI);

      // Emit CI discovered event
      await this.eventProducer.emit(
        EventType.CI_DISCOVERED,
        'identity-reconciliation-engine',
        {
          ci_id: ciId,
          ci_name: discoveredCI.name,
          ci_type: discoveredCI.ci_type,
          source_system: discoveredCI.source,
          confidence_score: discoveredCI.confidence_score,
          identifiers: discoveredCI.identifiers,
        } as any
      );

      return ciId;
    }
  }

  /**
   * Create new CI in Neo4j
   */
  private async createNewCI(ci: TransformedCI): Promise<string> {
    const session = this.neo4jClient.getSession();

    try {
      const ciId = this.generateCIId();

      const result = await session.run(
        `CREATE (ci:CI:${sanitizeCITypeForLabel(ci.ci_type)})
         SET ci = $properties
         RETURN ci.id as ci_id`,
        {
          properties: {
            id: ciId,
            name: ci.name,
            ci_type: ci.ci_type,
            environment: ci.environment,
            status: ci.status || 'active',
            ...ci.attributes,
            ...ci.identifiers,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
        }
      );

      // Record source lineage
      await this.recordSourceLineage(ciId, ci.source, ci.source_id, ci.confidence_score);

      logger.info('New CI created', { ci_id: ciId, name: ci.name });
      return result.records[0]?.get('ci_id') || ciId;
    } finally {
      await session.close();
    }
  }

  /**
   * Update existing CI with new data
   */
  private async updateExistingCI(ciId: string, ci: TransformedCI, match: MatchResult): Promise<void> {
    // Get source authority
    const sourceAuthority = this.config?.source_authorities[ci.source] || 5;

    // Merge fields using conflict resolution
    const mergedData = await this.mergeFields(ciId, ci, sourceAuthority);

    // Update Neo4j
    const session = this.neo4jClient.getSession();

    try {
      await session.run(
        `MATCH (ci:CI {id: $ciId})
         SET ci += $properties, ci.updated_at = datetime()
         RETURN ci`,
        {
          ciId,
          properties: mergedData
        }
      );

      // Update source lineage
      await this.recordSourceLineage(ciId, ci.source, ci.source_id, match.confidence);

      logger.info('CI updated', { ci_id: ciId, source: ci.source });
    } finally {
      await session.close();
    }
  }

  /**
   * Merge fields with conflict resolution
   */
  private async mergeFields(ciId: string, newCI: TransformedCI, sourceAuthority: number): Promise<any> {
    // Get existing field sources
    const existingFields = await this.getFieldSources(ciId);
    const mergedData: any = {};

    for (const [field, value] of Object.entries(newCI.attributes)) {
      const existing = existingFields.get(field);

      if (!existing) {
        // New field, just add it
        mergedData[field] = value;
        await this.recordFieldSource(ciId, field, value, newCI.source);
      } else {
        // Field exists, check authority
        const existingAuthority = this.config?.source_authorities[existing.source_name] || 5;

        if (sourceAuthority >= existingAuthority) {
          // New source has higher or equal authority
          mergedData[field] = value;
          await this.recordFieldSource(ciId, field, value, newCI.source);
        }
        // Otherwise keep existing value
      }
    }

    return mergedData;
  }

  /**
   * Get field sources for CI
   */
  private async getFieldSources(ciId: string): Promise<Map<string, any>> {
    const result = await this.postgresClient.query(
      'SELECT field_name, field_value, source_name FROM ci_field_sources WHERE ci_id = $1',
      [ciId]
    );

    const fields = new Map();
    for (const row of result.rows) {
      fields.set(row.field_name, {
        value: row.field_value,
        source_name: row.source_name
      });
    }

    return fields;
  }

  /**
   * Record source lineage
   */
  private async recordSourceLineage(
    ciId: string,
    sourceName: string,
    sourceId: string,
    confidence: number
  ): Promise<void> {
    await this.postgresClient.query(
      `INSERT INTO ci_source_lineage (ci_id, source_name, source_id, confidence_score, last_seen_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (ci_id, source_name, source_id)
       DO UPDATE SET last_seen_at = NOW(), confidence_score = $4`,
      [ciId, sourceName, sourceId, Math.round(confidence)]
    );
  }

  /**
   * Record field source
   */
  private async recordFieldSource(
    ciId: string,
    fieldName: string,
    fieldValue: any,
    sourceName: string
  ): Promise<void> {
    await this.postgresClient.query(
      `INSERT INTO ci_field_sources (ci_id, field_name, field_value, source_name, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (ci_id, field_name)
       DO UPDATE SET field_value = $3, source_name = $4, updated_at = NOW()`,
      [ciId, fieldName, String(fieldValue), sourceName]
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
