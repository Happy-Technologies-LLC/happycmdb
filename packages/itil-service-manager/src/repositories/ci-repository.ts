// Copyright 2026 Happy Technologies LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * CI Repository
 * Database access layer for Configuration Items
 */

import { getNeo4jClient, getPostgresClient } from '@cmdb/database';
import { ConfigurationItem, ITILLifecycle, ITILConfigStatus } from '@cmdb/unified-model';
import { CIHistoryEvent } from '../types';

export class CIRepository {
  /**
   * Get CI by ID from Neo4j
   */
  async getCI(ciId: string): Promise<ConfigurationItem | null> {
    const neo4j = getNeo4jClient();
    const session = neo4j.getSession();

    try {
      const result = await session.run(
        `
        MATCH (ci:CI {id: $ciId})
        RETURN ci
        `,
        { ciId }
      );

      if (result.records.length === 0) {
        return null;
      }

      const node = result.records[0].get('ci');
      return this.nodeToCI(node);
    } finally {
      await session.close();
    }
  }

  /**
   * Update CI ITIL attributes
   */
  async updateITILAttributes(
    ciId: string,
    updates: Partial<{
      lifecycle_stage: ITILLifecycle;
      configuration_status: ITILConfigStatus;
      version: string;
      baseline_id: string;
      last_audited: Date;
      audit_status: 'compliant' | 'non_compliant' | 'unknown';
    }>
  ): Promise<ConfigurationItem> {
    const neo4j = getNeo4jClient();
    const session = neo4j.getSession();

    try {
      // Get current CI
      const ci = await this.getCI(ciId);
      if (!ci) {
        throw new Error(`CI not found: ${ciId}`);
      }

      // Merge updates into itil_attributes
      const updatedItilAttributes = {
        ...ci.itil_attributes,
        ...updates,
      };

      const result = await session.run(
        `
        MATCH (ci:CI {id: $ciId})
        SET ci.itil_attributes = $itilAttributes,
            ci.updated_at = datetime()
        RETURN ci
        `,
        {
          ciId,
          itilAttributes: JSON.stringify(updatedItilAttributes),
        }
      );

      const node = result.records[0].get('ci');
      return this.nodeToCI(node);
    } finally {
      await session.close();
    }
  }

  /**
   * Get CIs due for audit
   * Returns CIs that haven't been audited in the last 90 days
   */
  async getCIsDueForAudit(daysThreshold: number = 90): Promise<ConfigurationItem[]> {
    const neo4j = getNeo4jClient();
    const session = neo4j.getSession();

    try {
      const thresholdDate = new Date();
      thresholdDate.setDate(thresholdDate.getDate() - daysThreshold);

      const result = await session.run(
        `
        MATCH (ci:CI)
        WHERE ci.itil_attributes IS NOT NULL
        WITH ci,
             apoc.convert.fromJsonMap(ci.itil_attributes) AS itil,
             datetime($thresholdDate) AS threshold
        WHERE datetime(itil.last_audited) < threshold
           OR itil.last_audited IS NULL
        RETURN ci
        ORDER BY itil.last_audited ASC
        `,
        { thresholdDate: thresholdDate.toISOString() }
      );

      return result.records.map((record) => this.nodeToCI(record.get('ci')));
    } finally {
      await session.close();
    }
  }

  /**
   * Get CI history from PostgreSQL audit logs
   */
  async getCIHistory(ciId: string, limit: number = 100): Promise<CIHistoryEvent[]> {
    const postgres = getPostgresClient();

    const result = await postgres.query(
      `
      SELECT * FROM cmdb.fact_ci_changes
      WHERE ci_key = (
        SELECT ci_key FROM cmdb.dim_ci
        WHERE ci_id = $1 AND is_current = TRUE
      )
      ORDER BY changed_at DESC
      LIMIT $2
      `,
      [ciId, limit]
    );

    return result.rows.map((row) => ({
      id: row.change_key.toString(),
      ciId: ciId,
      ciName: '', // Would need to join with dim_ci to get name
      eventType: this.mapChangeType(row.change_type),
      timestamp: row.changed_at,
      changes: [
        {
          field: row.field_name,
          oldValue: row.old_value,
          newValue: row.new_value,
        },
      ],
      performedBy: row.changed_by || 'system',
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }));
  }

  /**
   * Get CIs by business criticality
   */
  async getCIsByBusinessCriticality(
    criticality: string
  ): Promise<ConfigurationItem[]> {
    const neo4j = getNeo4jClient();
    const session = neo4j.getSession();

    try {
      const result = await session.run(
        `
        MATCH (ci:CI)
        WHERE ci.bsm_attributes IS NOT NULL
        WITH ci, apoc.convert.fromJsonMap(ci.bsm_attributes) AS bsm
        WHERE bsm.business_criticality = $criticality
        RETURN ci
        `,
        { criticality }
      );

      return result.records.map((record) => this.nodeToCI(record.get('ci')));
    } finally {
      await session.close();
    }
  }

  /**
   * Get configuration accuracy metrics
   */
  async getConfigurationAccuracyMetrics() {
    const neo4j = getNeo4jClient();
    const session = neo4j.getSession();

    try {
      const result = await session.run(`
        MATCH (ci:CI)
        WHERE ci.itil_attributes IS NOT NULL
        WITH ci, apoc.convert.fromJsonMap(ci.itil_attributes) AS itil
        RETURN
          count(ci) AS totalCIs,
          count(CASE WHEN itil.audit_status = 'compliant' THEN 1 END) AS compliantCIs,
          count(CASE WHEN itil.audit_status = 'non_compliant' THEN 1 END) AS nonCompliantCIs,
          count(CASE WHEN itil.audit_status = 'unknown' OR itil.audit_status IS NULL THEN 1 END) AS unknownCIs,
          count(CASE WHEN itil.last_audited IS NOT NULL THEN 1 END) AS auditedCIs
      `);

      const record = result.records[0];
      const totalCIs = record.get('totalCIs').toNumber();
      const compliantCIs = record.get('compliantCIs').toNumber();
      const nonCompliantCIs = record.get('nonCompliantCIs').toNumber();
      const _unknownCIs = record.get('unknownCIs').toNumber();
      const auditedCIs = record.get('auditedCIs').toNumber();

      return {
        totalCIs,
        auditedCIs,
        compliantCIs,
        nonCompliantCIs,
        uauditedCIs: totalCIs - auditedCIs,
        accuracyPercentage: totalCIs > 0 ? (auditedCIs / totalCIs) * 100 : 0,
        compliancePercentage: auditedCIs > 0 ? (compliantCIs / auditedCIs) * 100 : 0,
        cisDueForAudit: 0, // Calculated separately
        averageDaysSinceLastAudit: 0, // Calculated separately
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Get CIs by multiple IDs
   */
  async getCIsByIds(ciIds: string[]): Promise<ConfigurationItem[]> {
    if (ciIds.length === 0) {
      return [];
    }

    const neo4j = getNeo4jClient();
    const session = neo4j.getSession();

    try {
      const result = await session.run(
        `
        MATCH (ci:CI)
        WHERE ci.id IN $ciIds
        RETURN ci
        `,
        { ciIds }
      );

      return result.records.map((record) => this.nodeToCI(record.get('ci')));
    } finally {
      await session.close();
    }
  }

  /**
   * Convert Neo4j node to ConfigurationItem
   */
  private nodeToCI(node: any): ConfigurationItem {
    const props = node.properties;

    return {
      id: props.id,
      external_id: props.external_id,
      name: props.name,
      type: props.type,
      itil_attributes: props.itil_attributes
        ? JSON.parse(props.itil_attributes)
        : {},
      tbm_attributes: props.tbm_attributes ? JSON.parse(props.tbm_attributes) : {},
      bsm_attributes: props.bsm_attributes ? JSON.parse(props.bsm_attributes) : {},
      status: props.status,
      environment: props.environment,
      location: props.location || {},
      owner: props.owner || '',
      technical_contact: props.technical_contact || '',
      metadata: props.metadata ? JSON.parse(props.metadata) : {},
      created_at: props.created_at,
      updated_at: props.updated_at,
      created_by: props.created_by || 'system',
      updated_by: props.updated_by || 'system',
      discovered_by: props.discovery_provider || 'system',
      confidence_score: props.confidence_score || 1.0,
    } as any;
  }

  /**
   * Map change type to event type
   */
  private mapChangeType(changeType: string): CIHistoryEvent['eventType'] {
    switch (changeType) {
      case 'lifecycle_change':
        return 'lifecycle_change';
      case 'status_change':
        return 'status_change';
      case 'audit_completed':
        return 'audit_completed';
      case 'baseline_created':
        return 'baseline_created';
      default:
        return 'status_change';
    }
  }
}
